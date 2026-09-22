import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AliasConfigStore } from '../src/store.ts'
import { wireAliasSettingsBridge } from '../src/settings.ts'

/** Minimal settings service: captures the namespace watcher it is given. */
function fakeSettings() {
  let watchCb: ((next: unknown) => void) | undefined
  const replaced: unknown[] = []
  const settings = {
    register: (_namespace: string, _schema: unknown) => ({
      watch: (cb: (next: unknown) => void) => {
        watchCb = cb
      },
    }),
    replace: (_namespace: string, value: unknown) => {
      replaced.push(value)
    },
  }
  return { settings, replaced, fire: (next: unknown) => watchCb?.(next) }
}

/** Minimal cordis context: `inject` runs the callback with the settings stub. */
function fakeCtx(settings: unknown) {
  return {
    inject: (_deps: string[], callback: (ctx: unknown) => void) => {
      callback({ settings, logger: { warn: () => {} } })
      return () => {}
    },
  }
}

async function tempHome(config: unknown): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-alias-settings-'))
  await writeFile(join(home, 'workspace-alias.json'), JSON.stringify(config))
  process.env.DSH_HOME = home
  return home
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('alias settings bridge', () => {
  it('runs the change hook when an external JSON edit reloads the table', async () => {
    const home = await tempHome({ version: 1, groups: [], autoAttach: true })
    const store = new AliasConfigStore()
    await store.start()
    let calls = 0
    const fake = fakeSettings()
    wireAliasSettingsBridge(
      fakeCtx(fake.settings) as never,
      store,
      () => {
        calls++
      },
    )

    // Hand edit (or Syncthing swap) turning the adoption opt-in on: the table
    // reload is what the registry reacts to, so the flag takes effect without
    // an app restart.
    await writeFile(
      join(home, 'workspace-alias.json'),
      JSON.stringify({ version: 1, groups: [['/a', 'b']], autoAttach: true, adoptAliased: true }),
    )
    await store.reload()

    expect(store.current.adoptAliased).toBe(true)
    expect(calls).toBe(1)
  })

  it('persists adoptAliased written through the settings mirror', async () => {
    const home = await tempHome({ version: 1, groups: [], autoAttach: true })
    const store = new AliasConfigStore()
    await store.start()
    let calls = 0
    const fake = fakeSettings()
    wireAliasSettingsBridge(
      fakeCtx(fake.settings) as never,
      store,
      () => {
        calls++
      },
    )

    fake.fire({ groups: [['/a', 'b']], autoAttach: true, adoptAliased: true })

    const file = join(home, 'workspace-alias.json')
    let saved: Record<string, unknown> = {}
    await waitFor(() => {
      try {
        saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      } catch {
        return false
      }
      return saved.adoptAliased === true
    })
    expect(saved.groups).toEqual([['/a', 'b']])
    expect(saved.autoAttach).toBe(true)
    // The settings path also reloads the table, which is what triggers the work.
    expect(calls).toBe(1)
  })
})
