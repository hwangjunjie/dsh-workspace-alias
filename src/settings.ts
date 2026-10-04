/**
 * Settings-UI bridge: exposes the alias table through the DSH settings
 * service so users edit groups in the built-in settings page instead of
 * hand-editing `workspace-alias.json`.
 *
 * Architecture (why a mirror, not a migration):
 *
 * - `workspace-alias.json` stays the single true source. It lives in the
 *   cross-machine sync scope, so one table is shared by every machine —
 *   moving the truth into per-machine `settings.yaml` would break that
 *   (a group added on the Mac must be visible on Windows and vice versa).
 * - The settings namespace is a *mirror*: the plugin pushes the JSON
 *   content into it (UI displays exactly the true source), and user edits
 *   made in the settings page flow back into the JSON file.
 * - Loop guard: every direction passes through `canonicalShape()` string
 *   comparison against `lastMirror`; a change is only propagated when it
 *   did not originate from the other side. Writes on both sides are
 *   idempotent, so even a race converges instead of oscillating.
 *
 * Two host generations are supported, because the settings surface changed in
 * DSH 0.2.0-rc: the namespace-scoped `settings.register()` service was removed
 * and settings pages are now served from the loader entry's own `.volatile()`
 * config (written through `configEditor.edit`). `wireAliasConfigBridge()`
 * drives that surface; `wireAliasSettingsBridge()` drives the old one. Both
 * implement the same JSON-as-true-source mirror, and the one whose surface is
 * absent is a no-op.
 *
 * The whole bridge is optional: when the settings service is not mounted
 * (host without `dsh-settings`), `ctx.inject(['settings'], ...)` never
 * fires and the plugin keeps working exactly as before (JSON file +
 * watcher, hand editing only).
 * @module dsh-workspace-alias/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  aliasConfigPath,
  canonicalShape,
  fromSettingsShape,
  saveAliasConfig,
  toSettingsShape,
  type AliasSettingsShape,
} from './alias.ts'
import type { AliasConfigStore } from './store.ts'

/** Settings namespace owned by this plugin (lowercase-hyphenated per host). */
export const ALIAS_SETTINGS_NAMESPACE = 'workspace-alias'

/**
 * Schema rendered by the settings page. Field order matters: the resolved
 * value's key order follows it, keeping `canonicalShape()` comparisons
 * stable against `toSettingsShape()` output.
 */
export const AliasSettingsSchema = z.object({
  autoAttach: z
    .boolean()
    .default(true)
    .description('启动时把经别名解析的跨机会话自动附加到本地 workspace'),
  adoptAliased: z
    .boolean()
    .default(false)
    .description(
      '启动时把「cwd 命中别名组、但当前没有任何 workspace 归属」的存量会话附加到对应 workspace。' +
        '用于修复历史遗留的未分组会话（早期版本已把 header 改写成本机路径的会话，无法再被识别为跨机来源）。' +
        '注意：手动 detach 不留墓碑，开启后别名项目里被刻意移出的会话会在下次启动被重新挂上。',
    ),
  groups: z
    .array(z.array(z.string()))
    .description(
      '别名组：每组内的路径指向不同机器上的同一个项目目录（如 macOS /Volumes/Data/notes 与 Windows F:\\notes）。' +
        '本机不存在的成员用于解析从其他机器同步来的会话。',
    ),
})

/**
 * Whether the schemastery the host provides understands `.volatile()`. The
 * marker (and the whole config-backed settings surface) arrived with DSH
 * 0.2.0-rc, so this doubles as "is this host's settings page fed from plugin
 * config". Probed instead of hardcoded: the plugin resolves schemastery from
 * the host, and an older host must keep the namespace-scoped bridge.
 */
const VOLATILE_MARKER = (z.boolean() as unknown as { volatile?: unknown }).volatile
export const HOST_SETTINGS_ARE_CONFIG_BACKED = typeof VOLATILE_MARKER === 'function'

/** Apply the `.volatile()` marker when the host's schemastery supports it. */
function volatileField<T>(schema: T): T {
  if (!HOST_SETTINGS_ARE_CONFIG_BACKED) return schema
  return (schema as unknown as { volatile(): T }).volatile()
}

/**
 * Schema of the plugin entry's own config on DSH >= 0.2.0-rc, where settings
 * pages are served by the host from the loader entry (see
 * {@link wireAliasConfigBridge}). Every field is `.volatile()`: editing one
 * commits the new value into the running plugin instead of remounting it,
 * which is what keeps `workspace-alias.json` writes idempotent while the
 * settings page stays open.
 */
export const AliasSettingsConfig = z.object({
  autoAttach: volatileField(z.boolean().default(true)).description(
    '启动时把经别名解析的跨机会话自动附加到本地 workspace',
  ),
  adoptAliased: volatileField(z.boolean().default(false)).description(
    '启动时把 cwd 命中别名组的存量会话附加到对应 workspace',
  ),
  groups: volatileField(z.array(z.array(z.string())).default([])).description(
    '别名组：组内路径指向不同机器上的同一个项目目录',
  ),
})

/** Per-field config references the loader hands to the plugin constructor. */
export interface AliasSettingsRefs {
  autoAttach?: { get(): unknown }
  adoptAliased?: { get(): unknown }
  groups?: { get(): string[][] | undefined }
}

/**
 * Wire the JSON <-> settings mirror for hosts whose settings pages are built
 * from the plugin entry's own config (DSH >= 0.2.0-rc: `settings.register` was
 * removed, pages are served by `@deepseek-ai/dsh-settings` from the loader
 * entry's `.volatile()` fields, and edits are persisted through
 * `configEditor.edit`).
 *
 * `refs` are the per-field config references the loader hands to the plugin
 * constructor (see `AliasSettingsConfig`); they are the live view of the
 * profile-side settings document. When the host has no such surface (fields
 * are not references, no config editor) this is a no-op and the older
 * namespace bridge — or hand-edited JSON — stays in charge.
 *
 * Same two-way contract as {@link wireAliasSettingsBridge}: JSON is the true
 * source, the settings document is the mirror, and `canonicalShape()` string
 * comparison against `lastMirror` stops each direction from echoing the other.
 */
export function wireAliasConfigBridge(
  ctx: Context,
  store: AliasConfigStore,
  refs: AliasSettingsRefs | undefined,
  afterChange?: () => void,
): void {
  const anyCtx = ctx as any
  const groupsRef = refs?.groups
  if (typeof groupsRef?.get !== 'function') return

  const logger = anyCtx.logger
  const warn = (message: string): void => {
    logger?.warn?.(`[dsh-workspace-alias] ${message}`)
  }

  let lastMirror = canonicalShape(toSettingsShape(store.current))
  let writeChain: Promise<void> = Promise.resolve()
  // Mirror writes are only trusted once our own push landed: an entry whose
  // config still holds schema defaults must never overwrite the shared table
  // (the JSON file is the Syncthing-synced copy for every machine).
  let pushed = false

  /** Write the mirror value into the profile settings document. */
  const pushToConfig = async (shape: { autoAttach: boolean; adoptAliased: boolean; groups: string[][] }): Promise<void> => {
    const editor = typeof anyCtx.get === 'function' ? anyCtx.get('configEditor') : undefined
    const entry = anyCtx.fiber?.entry
    if (typeof editor?.edit !== 'function' || entry === undefined) {
      throw new Error('host exposes no configEditor for the settings document')
    }
    await editor.edit(entry, () => ({
      autoAttach: shape.autoAttach === true,
      adoptAliased: shape.adoptAliased === true,
      groups: shape.groups.map((group) => [...group]),
    }))
  }

  const autoRef = refs?.autoAttach
  const adoptRef = refs?.adoptAliased

  const readBool = (ref: { get(): unknown } | undefined, fallback: boolean): boolean => {
    const value = ref?.get?.()
    return value === undefined ? fallback : value === true
  }

  const readConfigShape = (): AliasSettingsShape => ({
    autoAttach: readBool(autoRef, true),
    adoptAliased: readBool(adoptRef, false),
    groups: (groupsRef.get() ?? []).map((group) => [...group]),
  })

  // Settings edit -> JSON true source. Subscribed BEFORE the initial push so
  // no genuine edit can fall between the two.
  if (typeof anyCtx.on === 'function') {
    anyCtx.on('loader/volatile-update', () => {
      const next = readConfigShape()
      const canonicalNext = canonicalShape(next)
      // Echo of our own push, or the pre-push defaults: nothing to persist.
      if (canonicalNext === lastMirror || !pushed) return
      lastMirror = canonicalNext
      writeChain = writeChain.then(async () => {
        try {
          const shape = fromSettingsShape(next)
          // An empty table is never an edit: it means the settings document
          // has not caught up (fresh profile, reset). Writing it over the JSON
          // true source would empty the alias table for EVERY machine, so the
          // document is repaired from the file instead.
          if (shape.groups.length === 0 && store.current.groups.length > 0) {
            warn(
              `refused to empty workspace-alias.json: the settings document has 0 group(s) while the file has ${store.current.groups.length} — edit the JSON file directly to clear the table on purpose`,
            )
            const truth = toSettingsShape(store.current)
            lastMirror = canonicalShape(truth)
            await pushToConfig(truth).catch((error: unknown) => {
              warn(`settings document repair failed: ${String(error)}`)
            })
            return
          }
          await saveAliasConfig(aliasConfigPath(), shape)
          await store.reload()
          for (const message of store.drainDiagnostics()) warn(message)
        } catch (error) {
          // Never write invalid data over the shared table; the document keeps
          // the edited value while the file stays at its last good state.
          warn(`settings edit NOT written to workspace-alias.json: ${String(error)}`)
        }
      })
    })
  }

  // Initial push: the settings document starts as an exact copy of the true
  // source, overwriting stale defaults or a layer left by an older run.
  void Promise.resolve()
    .then(() => pushToConfig(toSettingsShape(store.current)))
    .then(() => {
      pushed = true
    })
    .catch((error: unknown) => {
      // Stay functional (the empty-table guard still protects the bulk of the
      // table); a later edit is what would otherwise be silently dropped.
      pushed = true
      warn(`initial settings document write failed (settings UI shows stale values): ${String(error)}`)
    })

  // JSON change (other machine via sync, or hand edit) -> settings document.
  store.onChange = (): void => {
    const shape = toSettingsShape(store.current)
    const canonicalNow = canonicalShape(shape)
    if (canonicalNow !== lastMirror) {
      lastMirror = canonicalNow
      void Promise.resolve()
        .then(() => pushToConfig(shape))
        .catch((error: unknown) => {
          warn(`settings document update failed: ${String(error)}`)
        })
    }
    // The table may have flipped a behavior flag, so tell the owner after the
    // mirror write is queued.
    try {
      afterChange?.()
    } catch (error: unknown) {
      warn(`config-change hook failed: ${String(error)}`)
    }
  }
}

/**
 * Wire the JSON <-> settings mirror. Called from `Service.init`; when the
 * settings service is absent this resolves to a no-op.
 *
 * `afterChange` runs whenever the in-memory table really changed — a settings
 * edit or an external (synced / hand-edited) JSON edit. The owner uses it to
 * re-run work that depends on the table, so that switching a flag on (for
 * example `adoptAliased`) takes effect without an app restart.
 */
export function wireAliasSettingsBridge(
  ctx: Context,
  store: AliasConfigStore,
  afterChange?: () => void,
): void {
  const inject = (ctx as any).inject?.bind(ctx)
  if (typeof inject !== 'function') return
  inject(['settings'], (settingsCtx: any) => {
    const settings = settingsCtx.settings
    const logger = settingsCtx.logger
    if (!settings?.register) return
    let scope: any
    try {
      scope = settings.register(ALIAS_SETTINGS_NAMESPACE, AliasSettingsSchema)
    } catch (error) {
      logger?.warn?.(
        `[dsh-workspace-alias] settings namespace registration failed — falling back to hand-edited JSON: ${String(error)}`,
      )
      return
    }

    // `lastMirror` is the canonical string of the content both sides last
    // agreed on. Every propagation updates it before performing its write,
    // so the opposite direction recognizes its own echo and stops.
    let lastMirror = canonicalShape(toSettingsShape(store.current))
    let writeChain: Promise<void> = Promise.resolve()
    // The mirror is only trusted once our own push has landed. A namespace
    // that has just been registered can report a value built from schema
    // defaults, or the value a previous run of an older build left behind —
    // neither is a user edit, and treating it as one silently overwrites the
    // true source (observed risk: a mirror that never knew `adoptAliased`
    // pushing `false` over the file's `true`, quietly cancelling the one-shot
    // backlog adoption).
    let pushed = false

    const warn = (message: string): void => {
      logger?.warn?.(`[dsh-workspace-alias] ${message}`)
    }

    // Initial push: the mirror starts as an exact copy of the true source,
    // overwriting any stale user layer left by a previous run.
    void Promise.resolve()
      .then(() =>
        settings.replace(ALIAS_SETTINGS_NAMESPACE, toSettingsShape(store.current)),
      )
      .then(() => {
        pushed = true
      })
      .catch((error: unknown) => {
        // Keep the bridge functional: the empty-table guard below still
        // protects the bulk of the table if the mirror is left on defaults.
        pushed = true
        warn(`initial settings mirror failed (UI shows defaults until next sync): ${String(error)}`)
      })

    // UI edit -> JSON true source. Serialized so overlapping edits land in
    // order; each write reloads the in-memory table immediately (the file
    // watcher is best-effort and must not be load-bearing here).
    scope.watch?.((next: unknown) => {
      const canonicalNext = canonicalShape(next)
      if (canonicalNext === lastMirror) return
      // Before the initial push lands there is no evidence that `next` is a
      // user edit rather than the mirror's stale/default value, so it is only
      // remembered as the current mirror content, never written to the file.
      if (!pushed) return
      lastMirror = canonicalNext
      writeChain = writeChain.then(async () => {
        try {
          const shape = fromSettingsShape(next)
          // An empty mirror is never an edit: it is a mirror that has not
          // caught up (fresh install, namespace re-registered from schema
          // defaults, a settings reset). Writing it over the JSON true source
          // would empty the shared alias table for EVERY machine, because the
          // file is the Syncthing-synced copy — observed on 2026-09-22, when
          // one machine's empty mirror wiped the table for the other. So an
          // empty table never wins over a populated one, and the mirror is
          // repaired back to the file instead.
          if (shape.groups.length === 0 && store.current.groups.length > 0) {
            warn(
              `refused to empty workspace-alias.json: the settings mirror has 0 group(s) while the file has ${store.current.groups.length} — edit the JSON file directly to clear the table on purpose`,
            )
            const truth = toSettingsShape(store.current)
            lastMirror = canonicalShape(truth)
            await settings.replace(ALIAS_SETTINGS_NAMESPACE, truth)
            return
          }
          await saveAliasConfig(aliasConfigPath(), shape)
          await store.reload()
          for (const message of store.drainDiagnostics()) warn(message)
        } catch (error) {
          // Never write invalid data over the shared table; the mirror
          // keeps the UI value while the file stays at its last good state.
          warn(`settings edit NOT written to workspace-alias.json: ${String(error)}`)
        }
      })
    })

    // JSON change (other machine via sync, or hand edit) -> UI mirror.
    store.onChange = (): void => {
      const shape = toSettingsShape(store.current)
      const canonicalNow = canonicalShape(shape)
      if (canonicalNow !== lastMirror) {
        lastMirror = canonicalNow
        void Promise.resolve()
          .then(() => settings.replace(ALIAS_SETTINGS_NAMESPACE, shape))
          .catch((error: unknown) => {
            warn(`settings mirror update failed: ${String(error)}`)
          })
      }
      // The table behind this change may have flipped a behavior flag, so tell
      // the owner after the mirror write is queued.
      try {
        afterChange?.()
      } catch (error: unknown) {
        warn(`config-change hook failed: ${String(error)}`)
      }
    }
  })
}
