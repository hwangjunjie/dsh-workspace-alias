/**
 * dsh-workspace-alias — cross-device workspace path aliasing for DeepSeek
 * Harness.
 *
 * Replaces the official `@deepseek-ai/dsh-workspace` row (disabled via this
 * package's cordis.patch.yml) with a subclass whose session-cwd
 * canonicalization understands cross-device alias groups. Everything else
 * (durable domain, entity lifecycle, service name `workspaceRegistry`) is
 * inherited untouched, so `workspace-controller`, `ui-workspace` and the
 * sidebar keep working without any change.
 *
 * What changes vs stock:
 *  1. `indexHeader` resolves session header cwd through
 *     `aliasAwareRealpath` — a foreign cwd (synced from another machine,
 *     nonexistent locally) resolves to the local alias sibling, so synced
 *     sessions group under the local workspace of the same project.
 *  2. `Service.init` backfills cross-device sessions into the workspace record
 *     that owns the resolved path. Eligible are sessions whose cwd resolved
 *     through an alias this boot, sessions this boot's header migration just
 *     rewrote from a foreign path, and — only with the `adoptAliased` opt-in —
 *     unclaimed sessions whose canonical cwd is a declared alias member.
 *     Locally-created sessions follow the stock attach flow, and deliberately
 *     detached sessions have no claim and no foreign cwd, so the default pass
 *     cannot resurrect a detach (see `backfillForeignSessions`).
 *  3. Startup self-heal (`repairDuplicateClaims`): stock membership is
 *     never pruned (the bootstrap merge retains sessionIds it does not
 *     re-group), while `validateStoredState` hard-fails the whole plugin
 *     tree when one session is claimed by two workspace records. Since
 *     sessions sync across machines, such stale claims are a matter of
 *     time; we repair deterministically before validation instead of
 *     bricking: keep the claim whose workspace path matches the session's
 *     alias-resolved cwd, tie-break by registry order. Backfill also strips
 *     contradicting claims defensively before attaching.
 *
 * Config: `<dshHome>/workspace-alias.json` (see alias.ts) — editable either
 * by hand or through the DSH settings page (settings.ts mirrors the file
 * into a `workspace-alias` settings namespace; the file stays the synced
 * true source). Put the file in your file-sync scope so every machine
 * shares one table.
 * @module dsh-workspace-alias
 */

import { stat } from 'node:fs/promises'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  WorkspaceRegistry,
  realpathNormalize,
} from '@deepseek-ai/dsh-workspace'
import {
  aliasAwareRealpath,
  aliasMemberKeys,
  dshHomePath,
  pathKey,
  type AliasConfig,
} from './alias.ts'
import { migrateSessionHeaders } from './migrate.ts'
import { AliasConfigStore } from './store.ts'
import { wireAliasSettingsBridge } from './settings.ts'

const store = new AliasConfigStore()

/**
 * Sessions whose cwd resolved through an alias (foreign cwd). Backfill uses
 * this to attach exactly the cross-machine sessions — nothing else.
 */
const foreignResolved = new Set<SessionId>()

/**
 * Session ids whose stored header THIS boot's migration rewrote from a
 * foreign path to a local one. Migration runs before `super.init()`, so by
 * the time headers are indexed their cwd resolves locally and
 * `aliasAwareRealpath` reports `aliased: false` — without this set those
 * sessions would be indexed but never attached, which is exactly how synced
 * Windows sessions landed in the rail's ungrouped section. Membership is
 * deliberately not cleared by `aliasIndexHeader`: the rewrite, and with it
 * the only evidence of foreign origin, happens before the first index pass.
 */
const migratedThisBoot = new Set<SessionId>()

/**
 * Alias-aware indexHeader. Same contract as the stock private method, with
 * the cwd canonicalization swapped for `aliasAwareRealpath`. Assigned onto
 * the subclass prototype below (the parent declares it `private`, which is a
 * compile-time-only notion; runtime override is plain property assignment).
 */
async function aliasIndexHeader(this: any, header: SessionHeader): Promise<void> {
  this.headers.set(header.id, header)
  this.sessionPaths.delete(header.id)
  foreignResolved.delete(header.id)
  if (header.cwd === undefined) {
    this.invalidSessionPaths.set(header.id, 'header has no cwd')
    return
  }
  let resolution: { path: string; aliased: boolean }
  try {
    resolution = await aliasAwareRealpath(header.cwd, store.current, realpathNormalize)
  } catch {
    this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' does not resolve`)
    return
  }
  try {
    if (!(await stat(resolution.path)).isDirectory()) {
      this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' is not a directory`)
      return
    }
  } catch {
    this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' does not resolve`)
    return
  }
  this.sessionPaths.set(header.id, resolution.path)
  this.invalidSessionPaths.delete(header.id)
  if (resolution.aliased) foreignResolved.add(header.id)
}

/**
 * Strip session claims that contradict the session's alias-resolved cwd.
 * The stock registry never prunes `sessionIds` (bootstrap merge keeps
 * entries it does not re-group, and post-bootstrap there is no
 * reconciliation), but `validateStoredState` hard-fails the entire plugin
 * tree the moment one session is claimed by two records. Cross-machine
 * session sync (plus stock attach flows that tolerate foreign membership)
 * makes that state reachable, so instead of failing loud we repair:
 *
 * - the claim whose workspace `path` equals the session's alias-resolved
 *   cwd survives (this is the attach canon of `indexHeader`);
 * - when the header index is unavailable, or no record matches, the
 *   earliest claim in the durable registry order survives.
 *
 * Runs right after `recoverPendingMutation` (base init) so the first
 * `validateStoredState` sees a consistent table. Cheap when clean: one
 * table scan, zero writes.
 *
 * Exported for the regression test that pins the header-index input shape —
 * see `tests/repair.test.ts`.
 */
export async function repairDuplicateClaims(self: any): Promise<void> {
  const state = self.requireState?.() as { workspaceIds: string[] } | undefined
  const table = self.requireTable?.()
  if (!state || !table || table.size === 0) return

  // Populate the header index (alias-resolved sessionPaths) for the
  // arbiter. If sessionPersistence is unavailable, arbitration degrades to
  // registry order — still strictly better than refusing to start.
  try {
    // `sessionPersistence.list()` yields `{ header, ... }` snapshots, not bare
    // headers (cf. the stock `listStoredHeaders()`, which maps `.header`).
    // Handing snapshots to `replaceHeaderIndex` drives every entry into the
    // `header.cwd === undefined` branch, so the map it just cleared stays
    // empty. `WorkspaceEntity.sessionIds` is a getter that filters the durable
    // claims through that very map: the plugin tree stays healthy and nothing
    // is logged, yet every Workspace renders empty and every Session drops into
    // Ungrouped. This runs on every `enqueueOperation` — every registry write,
    // plus any plugin's post-boot reconcile — so the blanking lands right after
    // boot, before the renderer fetches its Workspace baseline. Map to the real
    // header, and never re-index on an input that cannot repopulate the map.
    const snapshots = await self.ctx.sessionPersistence.list()
    const headers = snapshots.map((row: any) =>
      row && row.header !== undefined ? row.header : row,
    )
    const usable = headers.some(
      (header: any) => header && typeof header.cwd === 'string',
    )
    await self.replaceHeaderIndex(
      usable ? headers : await self.listStoredHeaders(),
    )
  } catch {
    // fall through
  }

  const sessionPaths = self.sessionPaths as Map<string, string> | undefined
  const orderOf = new Map<string, number>(
    state.workspaceIds.map((id, index) => [id, index]),
  )
  const records = new Map<string, { path: string; sessionIds: string[] }>(
    table.entries(),
  )

  const betterClaim = (sessionId: string, left: string, right: string): string => {
    const score = (id: string): number => {
      const resolved = sessionPaths?.get(sessionId)
      const pathMatch = resolved !== undefined && records.get(id)?.path === resolved
      return (pathMatch ? 1 : 0) * 2 - (orderOf.get(id) ?? Number.MAX_SAFE_INTEGER) / 1e9
    }
    return score(left) >= score(right) ? left : right
  }

  // sessionId -> workspaceId that keeps the claim.
  const winner = new Map<string, string>()
  for (const [id, record] of records) {
    for (const sessionId of record.sessionIds) {
      const holder = winner.get(sessionId)
      winner.set(sessionId, holder === undefined ? id : betterClaim(sessionId, holder, id))
    }
  }

  let repaired = 0
  for (const [id, record] of records) {
    const seen = new Set<string>()
    const kept = record.sessionIds.filter((sid) => {
      if (winner.get(sid) !== id) return false
      if (seen.has(sid)) return false
      seen.add(sid)
      return true
    })
    if (kept.length === record.sessionIds.length) continue
    const dropped = record.sessionIds.length - kept.length
    await table.update(id, (current: any) => ({
      ...current,
      sessionIds: kept,
      updatedAt: new Date().toISOString(),
    }))
    repaired += dropped
    self.ctx.logger?.warn?.(
      `[dsh-workspace-alias] repaired workspace '${id}': stripped ${dropped} duplicate/stale session claim(s)`,
    )
  }
  if (repaired > 0) {
    self.ctx.logger?.warn?.(
      `[dsh-workspace-alias] repaired ${repaired} duplicate session claim(s): ` +
        'stock membership is never pruned, so cross-machine sync can leave a ' +
        'session claimed twice, which hard-fails validateStoredState',
    )
  }
}

/**
 * Base init calls `recoverPendingMutation()` immediately before the first
 * `validateStoredState`, and the domain cannot be opened twice, so the
 * repair hooks in there (prototype assignment — the base declares these
 * members `private`, which is compile-time only).
 */
async function recoverPendingMutationWithRepair(this: any): Promise<void> {
  await (WorkspaceRegistry.prototype as any).recoverPendingMutation.call(this)
  await repairDuplicateClaims(this)
}

/**
 * The mountable replacement for `@deepseek-ai/dsh-workspace`. Same service
 * name (`workspaceRegistry`), same durable domain, alias-aware session-cwd
 * canonicalization.
 */
export class AliasWorkspaceRegistry extends WorkspaceRegistry {
  static override inject = ['storageDomain', 'sessionPersistence']

  /** True once the stock registry state exists (set at the end of init). */
  private ready = false

  constructor(ctx: Context) {
    // WorkspaceRegistry hardcodes the service name internally; pass ctx only.
    super(ctx)
  }

  protected override async [Service.init](): Promise<void> {
    await store.start()
    for (const message of store.drainDiagnostics()) {
      this.ctx.logger?.warn?.(`[dsh-workspace-alias] ${message}`)
    }
    // Settings-UI bridge (no-op when the host has no settings service):
    // the JSON file stays the synced true source, the settings namespace
    // mirrors it for in-app editing.
    //
    // Either route a later config edit can take — the JSON file watcher or the
    // settings namespace — ends in `store.onChange`, so both install the same
    // reaction: turning `adoptAliased` on (settings UI, hand edit, or a synced
    // file) must adopt the backlog right away instead of on the next boot.
    store.onChange = () => this.onAliasConfigChanged()
    wireAliasSettingsBridge(this.ctx, store, () => this.onAliasConfigChanged())
    // Before super.init(): migrated headers carry local paths, so the stock
    // indexHeader pass below groups them without any alias involvement.
    // Backfill then only handles sessions synced in after this boot.
    const report = await migrateSessionHeaders({
      dshHome: dshHomePath(),
      config: store.current,
      log: (message) => this.ctx.logger?.info?.(`[dsh-workspace-alias] ${message}`),
    })
    if (report.unsupportedRuntime) {
      this.ctx.logger?.warn?.(
        '[dsh-workspace-alias] node:zlib zstd unavailable — header cwd migration skipped',
      )
    }
    for (const message of report.unresolvable) {
      this.ctx.logger?.warn?.(`[dsh-workspace-alias] header cwd left as-is: ${message}`)
    }
    for (const message of report.errors) {
      this.ctx.logger?.warn?.(`[dsh-workspace-alias] header migration failed: ${message}`)
    }
    // Record what migration rewrote BEFORE the stock index pass: those
    // sessions' cwds are local now, so indexing alone can no longer tell
    // they came from another machine.
    for (const entry of report.rewritten) migratedThisBoot.add(entry.session as SessionId)
    await super[Service.init]()
    // `ready` gates the config-change reaction: a reload arriving before the
    // stock state exists must not run the attach pass.
    this.ready = true
    if (store.current.autoAttach) await this.backfillForeignSessions()
  }

  /**
   * React to a changed alias table. Only the boot-time init attaches
   * unconditionally; later changes re-run the same pass so a flag switched on
   * in the settings UI (or a table synced in from another machine) takes
   * effect immediately. A no-op before init and when autoAttach is off.
   */
  private onAliasConfigChanged(): void {
    if (!this.ready || !store.current.autoAttach) return
    void this.backfillForeignSessions().catch((error: unknown) => {
      this.ctx.logger?.warn?.(
        `[dsh-workspace-alias] attach pass after config change failed: ${String(error)}`,
      )
    })
  }

  /**
   * Attach cross-device sessions to the workspace owning their alias-resolved
   * path. Three eligibility classes, all of them "this session cannot have a
   * local attach decision behind it":
   *
   * 1. resolved through an alias fallback this boot (its cwd did not exist
   *    locally, so it could never have been attached/detached here);
   * 2. rewritten by this boot's migration (same argument — the foreign cwd is
   *    what was on disk one moment ago);
   * 3. with the explicit `adoptAliased` opt-in, any unclaimed session whose
   *    canonical cwd is a declared alias-group member — the backlog case,
   *    which classes 1 and 2 cannot recognize because an earlier boot already
   *    consumed the foreign cwd. Off by default: `detachSession` leaves no
   *    tombstone, so adoption cannot distinguish a deliberate detach from a
   *    never-attached session.
   *
   * Runs on the registry write chain via the entity's own mutate (private is
   * compile-time only), so durability, updatedAt stamping, and membership
   * pruning are exactly the stock ones.
   */
  private async backfillForeignSessions(): Promise<void> {
    const state = (this as any).requireState?.() as
      | { workspaceIds: readonly string[] }
      | undefined
    if (!state) return
    const table = (this as any).requireTable?.()
    if (!table) return
    let attached = 0
    let adopted = 0
    const adoptAliased = store.current.adoptAliased === true
    // Resolved once: member keys cover both the literal declared path and its
    // realpath, because the paths we compare against are already resolved.
    const declaredKeys = adoptAliased
      ? await aliasMemberKeys(store.current, realpathNormalize)
      : new Set<string>()
    for (const workspaceId of state.workspaceIds) {
      const entity = (this as any).entities?.get(workspaceId)
      const record = table.get(workspaceId)
      if (!entity || !record) continue
      for (const [sessionId, path] of (this as any).sessionPaths as Map<SessionId, string>) {
        if (path !== record.path) continue
        if (record.sessionIds.includes(sessionId)) continue
        const migrated = foreignResolved.has(sessionId) || migratedThisBoot.has(sessionId)
        if (!migrated) {
          if (!adoptAliased) continue
          const headerCwd = ((this as any).headers as Map<SessionId, SessionHeader> | undefined)
            ?.get(sessionId)?.cwd
          const declared =
            declaredKeys.has(pathKey(path)) ||
            (headerCwd !== undefined && declaredKeys.has(pathKey(headerCwd)))
          if (!declared) continue
        }
        try {
          // Defensive: strip contradicting claims from other records first.
          // Without this, attaching to the path-owning workspace when a
          // stale claim exists elsewhere would create exactly the duplicate
          // that hard-fails validateStoredState.
          for (const [otherId, other] of table.entries()) {
            if (otherId === workspaceId || !other.sessionIds.includes(sessionId)) continue
            await table.update(otherId, (current: any) => ({
              ...current,
              sessionIds: current.sessionIds.filter((sid: SessionId) => sid !== sessionId),
              updatedAt: new Date().toISOString(),
            }))
            this.ctx.logger?.warn?.(
              `[dsh-workspace-alias] stripped stale claim of session '${String(sessionId)}' from workspace '${String(otherId)}' (resolves to '${path}')`,
            )
          }
          await (entity as any).mutate((current: any) =>
            current.sessionIds.includes(sessionId)
              ? current
              : { ...current, sessionIds: [sessionId, ...current.sessionIds] },
          )
          attached++
          if (!migrated) adopted++
        } catch (error) {
          this.ctx.logger?.warn?.(
            `[dsh-workspace-alias] backfill of session '${String(sessionId)}' failed: ${String(error)}`,
          )
        }
      }
    }
    if (attached > 0) {
      this.ctx.logger?.info?.(
        `[dsh-workspace-alias] attached ${attached} cross-device session(s) via alias`,
      )
    }
    if (adopted > 0) {
      this.ctx.logger?.info?.(
        `[dsh-workspace-alias] adopted ${adopted} previously unclaimed session(s) whose cwd is a declared alias member (adoptAliased)`,
      )
    }
  }
}

// Runtime override (see aliasIndexHeader doc). The parent's private marker is
// compile-time only; assigning on our own subclass prototype affects only our
// instances.
;(AliasWorkspaceRegistry.prototype as any).indexHeader = aliasIndexHeader
;(AliasWorkspaceRegistry.prototype as any).recoverPendingMutation =
  recoverPendingMutationWithRepair

export { loadAliasConfig, aliasConfigPath, dshHomePath, pathKey } from './alias.ts'
export { migrateSessionHeaders, projectKey, zstdFrameSize } from './migrate.ts'
export { ALIAS_SETTINGS_NAMESPACE, AliasSettingsSchema, wireAliasSettingsBridge } from './settings.ts'
export { AliasConfigStore } from './store.ts'
export type { AliasConfig, AliasGroup, AliasSettingsShape } from './alias.ts'
export type { MigrationReport, RewrittenEntry } from './migrate.ts'
export default AliasWorkspaceRegistry
