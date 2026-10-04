import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AliasConfigStore } from '../src/store.ts'
import { wireAliasConfigBridge } from '../src/settings.ts'

type Shape = { autoAttach: boolean; adoptAliased: boolean; groups: string[][] }

/** Live per-field config references, as the loader hands them to a plugin. */
function configRefs(initial: Shape) {
  const state: Shape = {
    autoAttach: initial.autoAttach,
    adoptAliased: initial.adoptAliased,
    groups: initial.groups.map((group) => [...group]),
  }
  return {
    set(next: Shape) {
      state.autoAttach = next.autoAttach
      state.adoptAliased = next.adoptAliased
      state.groups = next.groups.map((group) => [...group])
    },
    refs: {
      autoAttach: { get: () => state.autoAttach },
      adoptAliased: { get: () => state.adoptAliased },
      groups: { get: () => state.groups.map((group) => [...group]) },
    },
  }
}

/** Minimal configEditor: captures what `edit` would persist. */
function fakeEditor() {
  const edits: Shape[] = []
  return {
    edits,
    editor: {
      edit: (_entry: unknown, change: (current: unknown, inherited: unknown) => Shape) => {
        edits.push(change({}, {}))
        return Promise.resolve()
      },
    },
  }
}

/** Minimal host context for the new-generation bridge. */
function fakeCtx(editor: unknown, entry: unknown) {
  const handlers: Array<(paths: unknown) => void> = []
  const ctx = {
    logger: { warn: () => {} },
    get: (name: string) => (name === 'configEditor' ? editor : undefined),
    fiber: { entry },
    on: (event: string, handler: (paths: unknown) => void) => {
      if (event === 'loader/volatile-update') handlers.push(handler)
    },
  }
  return { ctx, fire: () => handlers.forEach((handler) => handler([['groups']])), watches: () => handlers.length }
}

async function tempHome(config: unknown): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-alias-config-'))
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

const JSON_TABLE = {
  version: 1,
  autoAttach: true,
  adoptAliased: false,
  groups: [['/Volumes/Data/notes', 'F:\\notes']],
}

describe('alias config bridge (DSH >= 0.2.0-rc settings surface)', () => {
  it('pushes the JSON table into the settings document on start', async () => {
    const home = await tempHome(JSON_TABLE)
    const store = new AliasConfigStore()
    await store.start()
    const { editor, edits } = fakeEditor()
    const { refs } = configRefs({ autoAttach: true, adoptAliased: false, groups: [] })
    const host = fakeCtx(editor, { id: 'workspace-alias' })

    wireAliasConfigBridge(host.ctx as never, store, refs as never)
    await waitFor(() => edits.length === 1)

    expect(edits[0]).toEqual({
      autoAttach: true,
      adoptAliased: false,
      groups: [['/Volumes/Data/notes', 'F:\\notes']],
    })
    expect(host.watches()).toBe(1)
    expect(readFileSync(join(home, 'workspace-alias.json'), 'utf8')).toContain('/Volumes/Data/notes')
  })

  it('ignores the echo of its own push', async () => {
    const home = await tempHome(JSON_TABLE)
    const store = new AliasConfigStore()
    await store.start()
    const { editor, edits } = fakeEditor()
    const config = configRefs({ autoAttach: true, adoptAliased: false, groups: [] })
    const host = fakeCtx(editor, { id: 'workspace-alias' })
    wireAliasConfigBridge(host.ctx as never, store, config.refs as never)
    await waitFor(() => edits.length === 1)

    // The host commits the pushed value; the resulting volatile update is not
    // an edit and must not bounce back into the JSON true source.
    config.set({ autoAttach: true, adoptAliased: false, groups: [['/Volumes/Data/notes', 'F:\\notes']] })
    host.fire()
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(edits.length).toBe(1)
    expect(JSON.parse(readFileSync(join(home, 'workspace-alias.json'), 'utf8'))).toEqual(JSON_TABLE)
  })

  it('writes a settings-page edit back to the JSON true source', async () => {
    const home = await tempHome(JSON_TABLE)
    const store = new AliasConfigStore()
    await store.start()
    const { editor, edits } = fakeEditor()
    const config = configRefs({ autoAttach: true, adoptAliased: false, groups: [] })
    const host = fakeCtx(editor, { id: 'workspace-alias' })
    wireAliasConfigBridge(host.ctx as never, store, config.refs as never)
    await waitFor(() => edits.length === 1)

    config.set({ autoAttach: false, adoptAliased: true, groups: [['/Volumes/Data/notes', 'F:\\notes'], ['/tmp/x']] })
    host.fire()
    await waitFor(() => store.current.groups.length === 2)

    const written = JSON.parse(readFileSync(join(home, 'workspace-alias.json'), 'utf8'))
    expect(written.groups).toEqual([['/Volumes/Data/notes', 'F:\\notes'], ['/tmp/x']])
    expect(written.autoAttach).toBe(false)
    expect(written.adoptAliased).toBe(true)
    // The write came from the settings page, not from a JSON edit: no repair.
    expect(edits.length).toBe(1)
  })

  it('refuses to empty the table from an uncaught-up settings document', async () => {
    const home = await tempHome(JSON_TABLE)
    const store = new AliasConfigStore()
    await store.start()
    const { editor, edits } = fakeEditor()
    const config = configRefs({ autoAttach: true, adoptAliased: false, groups: [] })
    const host = fakeCtx(editor, { id: 'workspace-alias' })
    wireAliasConfigBridge(host.ctx as never, store, config.refs as never)
    await waitFor(() => edits.length === 1)

    // A document that reports zero groups while the file has one is a document
    // that never caught up, never a deliberate clear.
    config.set({ autoAttach: true, adoptAliased: false, groups: [] })
    host.fire()
    await waitFor(() => edits.length === 2)

    expect(edits[1]).toEqual({
      autoAttach: true,
      adoptAliased: false,
      groups: [['/Volumes/Data/notes', 'F:\\notes']],
    })
    expect(JSON.parse(readFileSync(join(home, 'workspace-alias.json'), 'utf8'))).toEqual(JSON_TABLE)
  })

  it('stays out of the way when the host has no volatile config references', async () => {
    await tempHome(JSON_TABLE)
    const store = new AliasConfigStore()
    await store.start()
    const marker = (): void => {}
    store.onChange = marker
    const { editor, edits } = fakeEditor()
    const host = fakeCtx(editor, { id: 'workspace-alias' })

    wireAliasConfigBridge(host.ctx as never, store, undefined)

    expect(edits.length).toBe(0)
    expect(host.watches()).toBe(0)
    expect(store.onChange).toBe(marker)
  })
})
