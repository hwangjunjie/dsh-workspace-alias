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
