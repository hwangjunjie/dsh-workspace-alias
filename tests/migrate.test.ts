import { mkdtemp, readFile, realpath, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { canonicalRewriteTarget } from '../src/alias.ts'
import { migrateSessionHeaders, projectKey, zstdFrameSize } from '../src/migrate.ts'

async function makeEnv() {
  const localDir = await mkdtemp(join(tmpdir(), 'mig-proj-'))
  const realLocal = await realpath(localDir)
  const home = await mkdtemp(join(tmpdir(), 'mig-home-'))
  const sessionsDir = join(home, 'sessions')
  // Default bucket: the WRONG one (simulates a Windows-synced session dir).
  const staleBucket = join(sessionsDir, '--F-notes--')
  await mkdir(staleBucket, { recursive: true })
  const config = {
    version: 1 as const,
    groups: [['F:\\notes', localDir] as const],
    autoAttach: true,
  }
  return { localDir, realLocal, home, sessionsDir, staleBucket, config }
}

/** header frame + a second frame of event lines (dsh appends per-frame). */
function writeMultiFrame(headerJsonl: string, restJsonl: string): Buffer {
  return Buffer.concat([
    zstdCompressSync(Buffer.from(headerJsonl, 'utf8')),
    zstdCompressSync(Buffer.from(restJsonl, 'utf8')),
  ])
}

const SID = 'session-11111111-2222-3333-4444-555555555555'

function headerJsonl(cwd: string): string {
  return JSON.stringify({ type: 'session', version: 0, id: SID, createdAt: 1, cwd }) + '\n'
}

describe('projectKey', () => {
  it('matches the stock dsh-session-persistence-jsonl encoding', () => {
    expect(projectKey('F:\\notes')).toBe('--F-notes--')
    expect(projectKey('f:\\notes')).toBe('--f-notes--')
    expect(projectKey('/Volumes/Data/notes')).toBe('--Volumes-Data-notes--')
    expect(projectKey('/')).toBe('--root--')
    expect(projectKey('C:\\a b\\x')).toBe('--C-a~0020b-x--')
  })
})

describe('canonicalRewriteTarget', () => {
  const groups = [
    ['/Volumes/Data/notes', 'F:\\notes', '/Users/xxx/notes'],
    ['C:\\work', 'D:\\work'],
  ] as const
  it('picks the first POSIX member — deterministic across machines', () => {
    expect(canonicalRewriteTarget('F:\\notes', { groups })).toBe('/Volumes/Data/notes')
    expect(canonicalRewriteTarget('f:/NOTES/', { groups })).toBe('/Volumes/Data/notes')
  })
  it('returns null for groups with no POSIX member or no match', () => {
    expect(canonicalRewriteTarget('C:\\work', { groups })).toBeNull()
    expect(canonicalRewriteTarget('/somewhere/else', { groups })).toBeNull()
  })
})

describe('migrateSessionHeaders', () => {
  it('rewrites a foreign Windows cwd, relocates the dir, preserves later frames', async () => {
    const { home, staleBucket, sessionsDir, config, localDir } = await makeEnv()
    const sessionDir = join(staleBucket, SID)
    await mkdir(sessionDir)
    const restJsonl = JSON.stringify({ type: 'user', text: 'hello' }) + '\n' +
      JSON.stringify({ type: 'assistant', text: 'hi' }) + '\n'
    await writeFile(
      join(sessionDir, 'session.jsonl.zstd'),
      writeMultiFrame(headerJsonl('F:\\notes'), restJsonl),
    )

    const report = await migrateSessionHeaders({ dshHome: home, config })
    // rewrite target = the group's first POSIX member, raw string (no realpath)
    expect(report.rewritten).toHaveLength(1)
    expect(report.rewritten[0]).toMatchObject({ session: SID, from: 'F:\\notes', to: localDir })
    // directory relocated to the bucket derived from the NEW cwd
    expect(report.moved).toHaveLength(1)
    const newPath = join(sessionsDir, projectKey(localDir), SID, 'session.jsonl.zstd')
    const after = await readFile(newPath)
    const frame1Text = zstdDecompressSync(after.subarray(0, zstdFrameSize(after))).toString('utf8')
    expect(JSON.parse(frame1Text.split('\n')[0]).cwd).toBe(localDir)
    // later frames preserved
    const allText = decompressAll(after)
    expect(allText).toContain('"hello"')
    expect(allText).toContain('"hi"')
  })

  it('relocates an already-rewritten session left in a stale bucket (production regression)', async () => {
    // v0.2.0 rewrote headers but did not move directories: header cwd is the
    // valid local path while the dir still sits in the old bucket — exactly
    // the assertStoredIdentity failure seen in production.
    const { home, staleBucket, sessionsDir, config, realLocal } = await makeEnv()
    const sessionDir = join(staleBucket, SID)
    await mkdir(sessionDir)
    const restJsonl = JSON.stringify({ type: 'user', text: 'kept' }) + '\n'
    await writeFile(
      join(sessionDir, 'session.jsonl.zstd'),
      writeMultiFrame(headerJsonl(realLocal), restJsonl),
    )

    const report = await migrateSessionHeaders({ dshHome: home, config })
    expect(report.rewritten).toHaveLength(0)
    expect(report.moved).toHaveLength(1)
    const newPath = join(sessionsDir, projectKey(realLocal), SID, 'session.jsonl.zstd')
    const after = await readFile(newPath)
    expect(decompressAll(after)).toContain('"kept"')
  })

  it('is idempotent — second run rewrites and moves nothing', async () => {
    const { home, staleBucket, sessionsDir, config, localDir } = await makeEnv()
    const sessionDir = join(staleBucket, SID)
    await mkdir(sessionDir)
    await writeFile(
      join(sessionDir, 'session.jsonl.zstd'),
      zstdCompressSync(Buffer.from(headerJsonl('F:\\notes'))),
    )
    await migrateSessionHeaders({ dshHome: home, config })
    const finalPath = join(sessionsDir, projectKey(localDir), SID, 'session.jsonl.zstd')
    const once = await readFile(finalPath)
    const report = await migrateSessionHeaders({ dshHome: home, config })
    expect(report.rewritten).toHaveLength(0)
    expect(report.moved).toHaveLength(0)
    const twice = await readFile(finalPath)
    expect(twice.equals(once)).toBe(true)
  })

  it('leaves healthy local sessions byte-identical when already in the right bucket', async () => {
    const { home, sessionsDir, config, realLocal } = await makeEnv()
    const rightBucket = join(sessionsDir, projectKey(realLocal))
    await mkdir(rightBucket, { recursive: true })
    const sessionDir = join(rightBucket, SID)
    await mkdir(sessionDir)
    const buf = zstdCompressSync(Buffer.from(headerJsonl(realLocal)))
    await writeFile(join(sessionDir, 'session.jsonl.zstd'), buf)
    const report = await migrateSessionHeaders({ dshHome: home, config })
    expect(report.rewritten).toHaveLength(0)
    expect(report.moved).toHaveLength(0)
    expect((await readFile(join(sessionDir, 'session.jsonl.zstd'))).equals(buf)).toBe(true)
  })

  it('rewrites to the first POSIX member even when a later member exists locally', async () => {
    const { home, staleBucket, sessionsDir, config, localDir } = await makeEnv()
    // Insert a non-existent first POSIX member ahead of the local one: the
    // rewrite target must be order-deterministic, not "what exists here".
    const multiConfig = {
      ...config,
      groups: [['F:\\notes', '/decoy/first', localDir] as const],
    }
    const sessionDir = join(staleBucket, SID)
    await mkdir(sessionDir)
    await writeFile(
      join(sessionDir, 'session.jsonl.zstd'),
      writeMultiFrame(headerJsonl('F:\\notes'), '{"type":"user"}\n'),
    )
    const report = await migrateSessionHeaders({ dshHome: home, config: multiConfig })
    expect(report.rewritten).toHaveLength(1)
    expect(report.rewritten[0]!.to).toBe('/decoy/first')
    const newPath = join(sessionsDir, projectKey('/decoy/first'), SID, 'session.jsonl.zstd')
    await expect(readFile(newPath)).resolves.toBeTruthy()
  })

  it('reports unresolvable foreign cwd without touching the file', async () => {
    const { home, staleBucket, config } = await makeEnv()
    const sessionDir = join(staleBucket, SID)
    await mkdir(sessionDir)
    const buf = writeMultiFrame(headerJsonl('D:\\other\\proj'), '{"type":"user"}\n')
    await writeFile(join(sessionDir, 'session.jsonl.zstd'), buf)
    const report = await migrateSessionHeaders({ dshHome: home, config })
    expect(report.rewritten).toHaveLength(0)
    expect(report.moved).toHaveLength(0)
    expect(report.unresolvable).toHaveLength(1)
    expect((await readFile(join(sessionDir, 'session.jsonl.zstd'))).equals(buf)).toBe(true)
  })

  it('records undecodable files as errors and leaves them alone', async () => {
    const { home, staleBucket, config } = await makeEnv()
    const sessionDir = join(staleBucket, SID)
    await mkdir(sessionDir)
    const buf = Buffer.from('not zstd at all')
    await writeFile(join(sessionDir, 'session.jsonl.zstd'), buf)
    const report = await migrateSessionHeaders({ dshHome: home, config })
    expect(report.rewritten).toHaveLength(0)
    expect(report.errors).toHaveLength(1)
    expect((await readFile(join(sessionDir, 'session.jsonl.zstd'))).equals(buf)).toBe(true)
  })
})

/** Decompress every frame of a multistream zstd buffer via frame walking. */
function decompressAll(buf: Buffer): string {
  let out = ''
  let rest = buf
  while (rest.length > 0) {
    const size = zstdFrameSize(rest)
    out += zstdDecompressSync(rest.subarray(0, size)).toString('utf8')
    rest = rest.subarray(size)
  }
  return out
}
