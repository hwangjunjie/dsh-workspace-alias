/**
 * Watches `<dshHome>/workspace-alias.json` and hands out the current table.
 * A missing file is a valid "no aliases" state (the watcher still listens so
 * creating the file later takes effect without a restart).
 * @module dsh-workspace-alias/store
 */

import { watch } from 'node:fs'
import { aliasConfigPath, loadAliasConfig } from './alias.ts'
import type { AliasConfig } from './alias.ts'

export class AliasConfigStore {
  private config: AliasConfig = { version: 1, groups: [], autoAttach: true, adoptAliased: false }
  /** Canonical snapshot of {@link config}; detects real changes on reload. */
  private snapshot = JSON.stringify(this.config)
  private started = false
  /** Warnings and load errors, drained and logged by Service.init. */
  private diagnostics: string[] = []

  /**
   * Invoked after every reload that actually changed the table. The
   * settings bridge assigns this to push external (synced / hand-edited)
   * changes into the settings-UI mirror; absent bridge = no-op.
   */
  onChange: () => void = (): void => {}

  async start(): Promise<void> {
    // Always re-read from disk: cheap, and it means a config file created
    // after boot (or after a failed watcher) is picked up on next init.
    // Retried: a file mid-Syncthing-replacement can transiently fail to
    // parse; a retry 500ms later reads the settled copy.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.reload()
        break
      } catch {
        if (attempt >= 3) break
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
    if (this.started) return
    this.started = true
    const file = aliasConfigPath()
    try {
      watch(file, { persistent: false }, () => {
        void this.reload()
      }).on('error', () => {
        // Directory missing or platform watcher unavailable — reload stays
        // boot-time only; documented behavior.
      })
    } catch {
      // Watcher is best-effort; boot-time load always works.
    }
  }

  async reload(): Promise<void> {
    let next: AliasConfig
    try {
      next = await loadAliasConfig(aliasConfigPath(), (message) => {
        this.diagnostics.push(message)
      })
    } catch (error) {
      // A broken table must not take the registry down: keep the last good
      // config (or empty) and surface the problem through the DSH log —
      // console.warn never reaches it (root cause of the 2026-09-09 silent
      // alias outage that let the stock write path prune memberships).
      this.diagnostics.push(`alias config ignored: ${String(error)}`)
      console.warn('[dsh-workspace-alias] alias config ignored:', String(error))
      return
    }
    const nextSnapshot = JSON.stringify(next)
    if (nextSnapshot === this.snapshot) return
    this.config = next
    this.snapshot = nextSnapshot
    this.onChange()
  }

  /** Hand collected warnings/errors to the caller for ctx.logger output. */
  drainDiagnostics(): string[] {
    const drained = this.diagnostics
    this.diagnostics = []
    return drained
  }

  get current(): AliasConfig {
    return this.config
  }
}
