import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import AliasWorkspaceRegistry from '../src/index.ts'

/**
 * In-process integration test: real WorkspaceRegistry subclass + real cordis
 * Context, with mock storageDomain / sessionPersistence. Exercises the whole
 * chain: domain open → header index (alias-aware cwd canon) → bootstrap
 * grouping / replaceHeaderIndex → backfill.
 */

interface Header {
  id: string
  cwd?: string
  createdAt: number
}

function makeDomain() {
  const workspaces = new Map<string, any>()
  let state: any = { initialized: false, workspaceIds: [], archivedSessionIds: [] }
  const table = {
    get: (id: string) => workspaces.get(id),
    put: async (id: string, rec: any) => {
      workspaces.set(id, structuredClone(rec))
    },
    delete: async (id: string) => {
      workspaces.delete(id)
    },
    update: async (id: string, fn: (current: any) => any) => {
      const next = fn(structuredClone(workspaces.get(id)))
      workspaces.set(id, structuredClone(next))
      return structuredClone(next)
    },
    entries: () => [...workspaces.entries()],
    get size() {
      return workspaces.size
    },
  }
  const domain = {
    table: () => table,
    global: {
      get: () => structuredClone(state),
      set: async (s: any) => {
        state = s
      },
    },
    close: async () => {},
  }
  return {
    domain,
    table,
    getState: () => state,
    setState: (s: any) => {
      state = s
    },
  }
}

function makeCtx(domain: ReturnType<typeof makeDomain>, headers: Header[]) {
  const ctx = new Context() as any
  ctx.storageDomain = { open: async () => domain.domain }
  // NOTE: dsh-workspace@0.1.2-rc.1 (published) expects list() to return
  // SessionHeader[] directly — the snapshot.header projection only exists on
  // newer master. Keep the mock pinned to the published contract.
  ctx.sessionPersistence = { list: async () => headers }
  ctx.logger = { warn() {}, info() {} }
  ctx.get = () => undefined
  if (typeof ctx.effect !== 'function') ctx.effect = () => () => {}
  return ctx
}

async function setupHome(groups: string[][], extra: Record<string, unknown> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-alias-home-'))
  await writeFile(
    join(home, 'workspace-alias.json'),
    JSON.stringify({ version: 1, groups, ...extra }),
  )
  process.env.DSH_HOME = home
  return home
}

describe('AliasWorkspaceRegistry integration', () => {
  it('bootstrap: a foreign-cwd session groups under the local alias sibling', async () => {
    // The "local machine" has only the mac-style dir; F:\notes is foreign.
    const localDir = await mkdtemp(join(tmpdir(), 'dsh-alias-proj-'))
    const realLocal = await realpath(localDir)
    await setupHome([['F:\\notes', localDir]])

    const headers: Header[] = [
      { id: 's-foreign', cwd: 'F:\\notes', createdAt: 200 },
      { id: 's-native', cwd: localDir, createdAt: 100 },
    ]
    const domain = makeDomain()
    const registry = new AliasWorkspaceRegistry(makeCtx(domain, headers))

    await (registry as any)[Service.init]()

    const records = domain.table.entries()
    expect(records).toHaveLength(1)
    const [, record] = records[0]
    expect(record.path).toBe(realLocal)
    expect(record.sessionIds).toContain('s-foreign')
    expect(record.sessionIds).toContain('s-native')
  })

  it('backfill: a foreign session syncing into an initialized registry joins the local workspace', async () => {
    const localDir = await mkdtemp(join(tmpdir(), 'dsh-alias-proj-'))
    const realLocal = await realpath(localDir)
    await setupHome([['F:\\notes', localDir]])

    // Initialized registry that already owns the local workspace; a Mac
    // session arrives later via file sync and is not accounted yet.
    const domain = makeDomain()
    domain.table.put('ws-1', {
      path: realLocal,
      title: 'notes',
      sessionIds: ['s-native'],
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    })
    domain.setState({ initialized: true, workspaceIds: ['ws-1'], archivedSessionIds: [] })

    const headers: Header[] = [
      { id: 's-foreign', cwd: 'F:\\notes', createdAt: 300 },
      { id: 's-native', cwd: localDir, createdAt: 100 },
    ]
    const registry = new AliasWorkspaceRegistry(makeCtx(domain, headers))

    await (registry as any)[Service.init]()

    const record = domain.table.get('ws-1')
    expect(record.sessionIds).toContain('s-foreign')
    expect(record.sessionIds).toContain('s-native')
  })

  it('no alias table: foreign sessions stay ungrouped (stock behavior)', async () => {
    const localDir = await mkdtemp(join(tmpdir(), 'dsh-alias-proj-'))
    const home = await mkdtemp(join(tmpdir(), 'dsh-alias-home-'))
    // Create an EMPTY groups table, not a missing file: a missing file would
    // be fine too, but this proves the empty-config path also stays safe.
    await writeFile(join(home, 'workspace-alias.json'), JSON.stringify({ version: 1, groups: [] }))
    process.env.DSH_HOME = home

    const domain = makeDomain()
    const headers: Header[] = [{ id: 's-foreign', cwd: 'F:\\notes', createdAt: 100 }]
    const registry = new AliasWorkspaceRegistry(makeCtx(domain, headers))

    await (registry as any)[Service.init]()

    // Bootstrap must not create a workspace from an unresolvable cwd.
    expect(domain.table.entries()).toHaveLength(0)
    expect(domain.getState().initialized).toBe(true)
  })

  it('broken alias JSON does not take the registry down', async () => {
    const localDir = await mkdtemp(join(tmpdir(), 'dsh-alias-proj-'))
    const home = await mkdtemp(join(tmpdir(), 'dsh-alias-home-'))
    await writeFile(join(home, 'workspace-alias.json'), '{not json')
    process.env.DSH_HOME = home

    const domain = makeDomain()
    const headers: Header[] = [{ id: 's-native', cwd: localDir, createdAt: 100 }]
    const registry = new AliasWorkspaceRegistry(makeCtx(domain, headers))

    await (registry as any)[Service.init]()

    // Native sessions still bootstrap into a workspace; alias layer degrades.
    const records = domain.table.entries()
    expect(records).toHaveLength(1)
    expect(records[0][1].sessionIds).toContain('s-native')
  })

  it('attaches a session this boot migrated (foreign header rewritten to the local path)', async () => {
    // The production regression: migration rewrites the stored cwd to a path
    // that exists locally, so the alias fallback never fires on the next index
    // pass and the session used to stay ungrouped forever.
    const localDir = await mkdtemp(join(tmpdir(), 'dsh-alias-proj-'))
    const realLocal = await realpath(localDir)
    const home = await setupHome([['F:\\notes', localDir]])
    const sid = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const stale = join(home, 'sessions', '--F-notes--', sid)
    await mkdir(stale, { recursive: true })
    await writeFile(
      join(stale, 'session.v3.jsonl.zstd'),
      zstdCompressSync(
        Buffer.from(
          `${JSON.stringify({ type: 'session', version: 0, id: sid, createdAt: 1, cwd: 'F:\\notes' })}\n`,
          'utf8',
        ),
      ),
    )

    const domain = makeDomain()
    domain.table.put('ws-1', {
      path: realLocal,
      title: 'notes',
      sessionIds: [],
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    })
    domain.setState({ initialized: true, workspaceIds: ['ws-1'], archivedSessionIds: [] })

    // The host-visible header is the POST-migration one (local cwd): the alias
    // fallback cannot fire, so only the migration bookkeeping can attach it.
    const registry = new AliasWorkspaceRegistry(
      makeCtx(domain, [{ id: sid, cwd: realLocal, createdAt: 300 }]),
    )
    await (registry as any)[Service.init]()

    expect(domain.table.get('ws-1').sessionIds).toContain(sid)
  })

  it('adoptAliased: an already-rewritten backlog session is adopted once opted in', async () => {
    const localDir = await mkdtemp(join(tmpdir(), 'dsh-alias-proj-'))
    const realLocal = await realpath(localDir)
    await setupHome([['F:\\notes', localDir]], { adoptAliased: true })

    const domain = makeDomain()
    domain.table.put('ws-1', {
      path: realLocal,
      title: 'notes',
      sessionIds: [],
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    })
    domain.setState({ initialized: true, workspaceIds: ['ws-1'], archivedSessionIds: [] })

    // No session file on disk: nothing was migrated this boot, so the foreign
    // cwd is long gone and only `adoptAliased` can recognize the backlog.
    const registry = new AliasWorkspaceRegistry(
      makeCtx(domain, [{ id: 'session-backlog', cwd: realLocal, createdAt: 100 }]),
    )
    await (registry as any)[Service.init]()

    expect(domain.table.get('ws-1').sessionIds).toContain('session-backlog')
  })

  it('default (adoptAliased off): that same backlog session stays ungrouped', async () => {
    const localDir = await mkdtemp(join(tmpdir(), 'dsh-alias-proj-'))
    const realLocal = await realpath(localDir)
    await setupHome([['F:\\notes', localDir]])

    const domain = makeDomain()
    domain.table.put('ws-1', {
      path: realLocal,
      title: 'notes',
      sessionIds: [],
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    })
    domain.setState({ initialized: true, workspaceIds: ['ws-1'], archivedSessionIds: [] })

    const registry = new AliasWorkspaceRegistry(
      makeCtx(domain, [{ id: 'session-backlog', cwd: realLocal, createdAt: 100 }]),
    )
    await (registry as any)[Service.init]()

    // Conservative default: a detach leaves no tombstone, so never guess.
    expect(domain.table.get('ws-1').sessionIds).not.toContain('session-backlog')
  })
})
