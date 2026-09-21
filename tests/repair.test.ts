import { describe, expect, it } from 'vitest'
import { repairDuplicateClaims } from '../src/index.ts'

/**
 * Regression cover for the header index `repairDuplicateClaims` rebuilds on its
 * way to arbitrating duplicate claims.
 *
 * `sessionPersistence.list()` hands back `{ header, ... }` snapshots, not bare
 * headers (cf. the stock `listStoredHeaders()`, which maps `.header`). Handing
 * snapshots to `replaceHeaderIndex` drives every entry into the
 * `header.cwd === undefined` branch while the map was already cleared, so
 * `sessionPaths` ends up EMPTY. `WorkspaceEntity.sessionIds` is a getter that
 * filters the durable claims through that map, so the registry keeps serving
 * every Workspace with `sessionIds: []`: the rail shows each Workspace empty
 * and every Session under Ungrouped, workspace.json is never touched, and no
 * warning is logged. Because `repairDuplicateClaims` runs on every
 * `enqueueOperation` — every registry write, plus any plugin's post-boot
 * reconcile — the blanking used to land right after boot.
 */
function fakeSelf(rows: unknown[], storedHeaders: unknown[]) {
  const indexed: unknown[][] = []
  const self: any = {
    requireState: () => ({ workspaceIds: ['w1'] }),
    requireTable: () => new Map([['w1', { path: 'F:\\notes', sessionIds: ['s1'] }]]),
    ctx: { sessionPersistence: { list: async () => rows } },
    // The real registry's own maps; asserted after the call.
    headers: new Map(),
    sessionPaths: new Map(),
    invalidSessionPaths: new Map(),
    listStoredHeaders: async () => storedHeaders,
    replaceHeaderIndex: async (list: unknown[]) => {
      indexed.push(list)
      self.headers.clear()
      self.sessionPaths.clear()
      self.invalidSessionPaths.clear()
      for (const header of list as Array<{ id?: string; cwd?: string }>) {
        self.headers.set(header.id, header)
        if (header.cwd === undefined) {
          self.invalidSessionPaths.set(header.id, 'header has no cwd')
          continue
        }
        self.sessionPaths.set(header.id, header.cwd)
        self.invalidSessionPaths.delete(header.id)
      }
    },
  }
  return { self, indexed }
}

describe('repairDuplicateClaims header index', () => {
  it('re-indexes from the header nested in each persistence snapshot', async () => {
    const rows = [{ header: { id: 's1', cwd: 'F:\\notes' }, artifacts: [] }]
    const { self, indexed } = fakeSelf(rows, [{ id: 's1', cwd: 'F:\\notes' }])

    await repairDuplicateClaims(self)

    expect(indexed).toHaveLength(1)
    // Bare header, not the enclosing snapshot.
    expect(indexed[0]).toEqual([{ id: 's1', cwd: 'F:\\notes' }])
    expect(self.sessionPaths.get('s1')).toBe('F:\\notes')
    expect([...self.invalidSessionPaths.values()]).not.toContain('header has no cwd')
  })

  it('falls back to the stock header accessor when the rows carry no cwd', async () => {
    const { self, indexed } = fakeSelf([{ artifacts: [] }], [{ id: 's1', cwd: 'F:\\notes' }])

    await repairDuplicateClaims(self)

    expect(indexed).toHaveLength(1)
    expect(self.sessionPaths.get('s1')).toBe('F:\\notes')
  })

  it('keeps the alias-resolved index that the registry needs for membership', async () => {
    // A foreign cwd cannot resolve locally: the point is that the claim is
    // still indexed (and therefore still visible through the sessionIds
    // getter) rather than dropped by a wiped index.
    const rows = [{ header: { id: 's1', cwd: '/Volumes/Data/notes' } }]
    const { self } = fakeSelf(rows, [])

    await repairDuplicateClaims(self)

    expect(self.sessionPaths.size + self.invalidSessionPaths.size).toBeGreaterThan(0)
    expect(self.headers.has('s1')).toBe(true)
  })
})
