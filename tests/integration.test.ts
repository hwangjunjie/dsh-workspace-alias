import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

async function setupHome(groups: string[][]) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-alias-home-'))
  await writeFile(
    join(home, 'workspace-alias.json'),
    JSON.stringify({ version: 1, groups }),
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
})
