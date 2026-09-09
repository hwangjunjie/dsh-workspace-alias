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
 */
export function wireAliasSettingsBridge(ctx: Context, store: AliasConfigStore): void {
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

    const warn = (message: string): void => {
      logger?.warn?.(`[dsh-workspace-alias] ${message}`)
    }

    // Initial push: the mirror starts as an exact copy of the true source,
    // overwriting any stale user layer left by a previous run.
    void Promise.resolve()
      .then(() =>
        settings.replace(ALIAS_SETTINGS_NAMESPACE, toSettingsShape(store.current)),
      )
      .catch((error: unknown) => {
        warn(`initial settings mirror failed (UI shows defaults until next sync): ${String(error)}`)
      })

    // UI edit -> JSON true source. Serialized so overlapping edits land in
    // order; each write reloads the in-memory table immediately (the file
    // watcher is best-effort and must not be load-bearing here).
    scope.watch?.((next: unknown) => {
      const canonicalNext = canonicalShape(next)
      if (canonicalNext === lastMirror) return
      lastMirror = canonicalNext
      writeChain = writeChain.then(async () => {
        try {
          const shape = fromSettingsShape(next)
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
      if (canonicalNow === lastMirror) return
      lastMirror = canonicalNow
      void Promise.resolve()
        .then(() => settings.replace(ALIAS_SETTINGS_NAMESPACE, shape))
        .catch((error: unknown) => {
          warn(`settings mirror update failed: ${String(error)}`)
        })
    }
  })
}
