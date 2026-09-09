/**
 * One-time header cwd compat migration (v0.2).
 *
 * dsh-session validates every stored session header with the *platform*
 * `path.isAbsolute` before serving its history. A session synced from
 * Windows carries a Windows cwd (`F:\notes`), which is NOT absolute on
 * POSIX — the gateway then refuses to load the history ("session header
 * cwd must be an absolute path"). The reverse direction is fine: win32
 * `isAbsolute` accepts POSIX paths, so Mac-originated headers load on
 * Windows as-is.
 *
 * Because of that asymmetry, normalizing a foreign header's cwd to the
 * LOCAL alias member's canonical path is stable in both directions:
 * - POSIX form passes validation on macOS AND on Windows;
 * - each machine only rewrites headers that FAIL its own isAbsolute check,
 *   so after one rewrite the file never changes again (no sync ping-pong);
 * - workspace grouping keeps working: the rewritten cwd is the local
 *   sibling's realpath, and the other machine resolves it back through the
 *   alias group.
 *
 * But rewriting the cwd invalidates the on-disk *location*: the storage
 * backend derives the bucket directory from the header cwd (projectKey) and
 * re-derives it on every load (`assertStoredIdentity`), so a rewritten
 * session must also MOVE from the old bucket to the new one — otherwise the
 * whole plugin tree fails with "header id ... and cwd identify ...". This
 * module therefore also relocates session directories whose parent bucket
 * no longer matches `projectKey(header.cwd)`. A move is skipped when the
 * two spellings resolve to the same physical directory (case variants on
 * case-insensitive filesystems, mirroring the stock `sameFile` fallback).
 *
 * File format (verified on disk): `<dshHome>/sessions/<bucket>/<id>/
 * session.jsonl.zstd`, a zstd stream whose first frame holds the header
 * JSON line; later events are appended as additional frames. The rewrite
 * replaces frame 1 and keeps every subsequent frame byte-identical, so
 * dsh's append history is preserved untouched.
 * @module dsh-workspace-alias/migrate
 */

import { mkdir, readdir, readFile, rename, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { canonicalRewriteTarget, type AliasConfig } from './alias.ts'

export interface RewrittenEntry {
  session: string
  from: string
  to: string
}

export interface MigrationReport {
  scanned: number
  rewritten: RewrittenEntry[]
  /** Session directories relocated to the bucket derived from their cwd. */
  moved: string[]
  /** Foreign cwd that no alias group could resolve — left untouched. */
  unresolvable: string[]
  /** Files that could not be read/decoded — left untouched (stock error). */
  errors: string[]
  /** node:zlib lacks zstd — migration unavailable on this runtime. */
  unsupportedRuntime: boolean
}

/**
 * The bucket directory key for a project path — ported verbatim from
 * `dsh-session-persistence-jsonl` (`projectKey`), because the storage
 * identity check re-derives the session's physical location from the header
 * cwd on every load and our rewrite must land the directory where the
 * checker expects it. Separators (`/`, `\`, `:`) collapse to `-`, safe
 * characters pass through, anything else becomes `~XXXX` hex; the result is
 * stripped of leading dashes, capped at 251 chars and wrapped in `--`.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const ch = cwd[i]!
    const code = cwd.charCodeAt(i)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** Size of the zstd magic number. */
const ZSTD_MAGIC = 0xfd2fb528

/**
 * Exact compressed size of the first zstd frame, by walking the frame
 * structure (magic + header [+ window descriptor] + block chain [+
 * checksum]); block headers carry their payload size, so no decoding is
 * needed. Throws on anything that is not a well-formed frame start.
 */
export function zstdFrameSize(buf: Buffer, offset = 0): number {
  let p = offset
  if (buf.readUInt32LE(p) !== ZSTD_MAGIC) {
    throw new Error(`not a zstd frame at offset ${offset}`)
  }
  p += 4
  const fhd = buf[p++]!
  const fcsFlag = fhd >> 6
  const singleSegment = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  const dictIdSize = [0, 1, 2, 4][fhd & 3]!
  const fcsSize = fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
  if (!singleSegment) p += 1 // window descriptor
  p += dictIdSize + fcsSize
  for (;;) {
    const bh = buf[p]! | buf[p + 1]! << 8 | buf[p + 2]! << 16
    p += 3
    const type = (bh >> 1) & 3
    const size = bh >> 3
    if (type === 1) p += 1 // RLE: single payload byte
    else if (type === 3) throw new Error(`reserved block type at offset ${p - 3}`)
    else p += size // raw / compressed: size is the payload length
    if (bh & 1) break
  }
  if (checksum) p += 4
  return p - offset
}

/** Parse and shape-check the header JSON line of a stored session file. */
function parseHeaderLine(frame1Text: string): { id: string; cwd?: unknown } | null {
  const newline = frame1Text.indexOf('\n')
  const line = newline === -1 ? frame1Text : frame1Text.slice(0, newline)
  try {
    const obj = JSON.parse(line) as Record<string, unknown>
    if (obj.type !== 'session' || typeof obj.id !== 'string') return null
    return obj as { id: string; cwd?: unknown }
  } catch {
    return null
  }
}

/**
 * Scan every stored session under `<dshHome>/sessions` and rewrite headers
 * whose cwd fails the platform `isAbsolute` check but resolves through an
 * alias group. Everything else is left byte-identical.
 */
export async function migrateSessionHeaders(opts: {
  dshHome: string
  config: AliasConfig
  log?: (message: string) => void
}): Promise<MigrationReport> {
  const report: MigrationReport = {
    scanned: 0,
    rewritten: [],
    moved: [],
    unresolvable: [],
    errors: [],
    unsupportedRuntime: false,
  }
  if (typeof zstdDecompressSync !== 'function' || typeof zstdCompressSync !== 'function') {
    report.unsupportedRuntime = true
    return report
  }
  const sessionsDir = join(opts.dshHome, 'sessions')
  let buckets: string[]
  try {
    buckets = (await readdir(sessionsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return report // no sessions dir yet — nothing to do
  }
  for (const bucket of buckets) {
    const bucketDir = join(sessionsDir, bucket)
    let ids: string[]
    try {
      ids = (await readdir(bucketDir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      continue
    }
    for (const id of ids) {
      const file = join(bucketDir, id, 'session.jsonl.zstd')
      report.scanned++
      let buf: Buffer
      try {
        buf = await readFile(file)
      } catch {
        report.scanned-- // no zstd payload in this dir — not a stored session
        continue
      }
      try {
        const frame1Size = zstdFrameSize(buf)
        const frame1Text = zstdDecompressSync(buf.subarray(0, frame1Size)).toString('utf8')
        const header = parseHeaderLine(frame1Text)
        if (!header) {
          report.errors.push(`${id}: header line is not a session header`)
          continue
        }
        if (typeof header.cwd !== 'string') continue
        let cwd = header.cwd
        if (!isAbsolute(cwd)) {
          // Deterministic repair target: the group's first POSIX member, the
          // same string on every POSIX machine regardless of boot order.
          // (Grouping later resolves it to whatever exists locally; the
          // header only needs to be a stable, everywhere-valid absolute.)
          const target = canonicalRewriteTarget(cwd, opts.config)
          if (!target) {
            report.unresolvable.push(
              `${id}: cwd '${cwd}' matches a group with no POSIX member`,
            )
            continue
          }
          const newline = frame1Text.indexOf('\n')
          const newHeader = JSON.stringify({ ...(header as object), cwd: target })
          const newFrame1Text =
            newline === -1 ? newHeader : newHeader + frame1Text.slice(newline)
          const newBuf = Buffer.concat([
            zstdCompressSync(Buffer.from(newFrame1Text, 'utf8')),
            buf.subarray(frame1Size),
          ])
          const tmp = `${file}.alias-tmp`
          await writeFile(tmp, newBuf)
          await rename(tmp, file)
          cwd = target
          report.rewritten.push({ session: id, from: header.cwd, to: target })
        }
        // A rewritten (or previously rewritten) cwd changes the bucket the
        // storage checker derives from (id, cwd). Relocate the directory so
        // assertStoredIdentity finds it where the header says it lives.
        const sessionDirPath = dirname(file)
        const expectedBucket = projectKey(cwd)
        const currentBucket = dirname(sessionDirPath).split('/').pop() ?? ''
        if (currentBucket === expectedBucket) continue
        const expectedParent = join(sessionsDir, expectedBucket)
        // Case-variant spellings of the same directory are the same bucket
        // on case-insensitive filesystems (stock sameFile semantics) — skip.
        try {
          const [actualReal, expectedReal] = await Promise.all([
            realpath(dirname(sessionDirPath)),
            realpath(expectedParent),
          ])
          if (actualReal === expectedReal) continue
        } catch {
          // expected bucket does not exist yet — proceed with the move
        }
        const targetDir = join(expectedParent, id)
        try {
          await stat(targetDir)
          report.errors.push(
            `${id}: cannot move to ${expectedBucket}: target already exists`,
          )
          continue
        } catch {
          // target free
        }
        await mkdir(expectedParent, { recursive: true })
        await rename(sessionDirPath, targetDir)
        report.moved.push(`${id}: ${dirname(sessionDirPath)} -> ${targetDir}`)
      } catch (error) {
        report.errors.push(`${id}: ${String(error)}`)
      }
    }
  }
  if (report.rewritten.length > 0) {
    opts.log?.(
      `migrated ${report.rewritten.length} session header(s) to local paths: ` +
        report.rewritten.map((r) => `${r.session} (${r.from} -> ${r.to})`).join(', '),
    )
  }
  if (report.moved.length > 0) {
    opts.log?.(
      `relocated ${report.moved.length} session director(y/ies) to cwd-derived buckets: ` +
        report.moved.join(', '),
    )
  }
  return report
}
