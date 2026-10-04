import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The client half is a hand-written browser bundle, so it is exercised the way
 * the host loads it: evaluate the file, capture the module factory the
 * `window.__ModuleLoader__` wrapper hands over, and drive `apply` against fake
 * cordis contexts for both settings generations.
 */
function loadClient(): any {
  const source = readFileSync(join(process.cwd(), 'client', 'client.js'), 'utf8')
  let spec: any
  const win = {
    __ModuleLoader__: {
      load: (next: any) => {
        spec = next
      },
    },
  }
  new Function('window', source)(win)
  expect(spec.id).toBe('dsh-workspace-alias')
  return spec.factory((id: string) => {
    if (id === 'react') return {}
    throw new Error(`unexpected value import: ${id}`)
  })
}

function fakeConfigForms(snapshot: any) {
  const listeners: Array<() => void> = []
  const mutations: Array<{ ops: unknown; revision: unknown }> = []
  const whileServed: string[][] = []
  const state = { snapshot }
  const form = {
    getSnapshot: () => state.snapshot,
    subscribe: (listener: () => void) => {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    mutate: (ops: unknown, revision?: unknown) => {
      mutations.push({ ops, revision })
      return Promise.resolve(true)
    },
  }
  return {
    form,
    listeners,
    mutations,
    whileServed,
    setSnapshot: (next: any) => {
      state.snapshot = next
    },
    configForms: {
      get: (namespace: string) => {
        expect(namespace).toBe('workspace-alias')
        return form
      },
      whileServed: (namespaces: string[], register: (served: Set<string>) => unknown) => {
        whileServed.push(namespaces)
        return register(new Set(namespaces))
      },
    },
  }
}

/** Fake client ctx: `inject` only runs callbacks for services that exist. */
function fakeClientCtx(services: { configForms?: unknown; settingsScope?: unknown }) {
  const registrations: Array<{ spec: any; component: any }> = []
  const probed: string[][] = []
  const ctx: any = {
    slots: {
      inject: (_name: string, callback: () => unknown) => callback(),
      register: (spec: any, component: any) => {
        registrations.push({ spec, component })
        return () => {}
      },
    },
    inject: (deps: string[], callback: (scoped: any) => unknown) => {
      probed.push(deps)
      const scoped: any = { effect: (execute: () => unknown) => execute() }
      if (deps.includes('configForms')) scoped.configForms = services.configForms
      if (deps.includes('settingsScope')) scoped.settingsScope = services.settingsScope
      if (deps.includes('configForms') && services.configForms === undefined) return
      if (deps.includes('settingsScope') && services.settingsScope === undefined) return
      return callback(scoped)
    },
  }
  return { ctx, registrations, probed }
}

describe('workspace-alias client half', () => {
  it('declares only services every supported client has', () => {
    const mod = loadClient()
    expect(mod.inject).toEqual(['slots'])
    // Regression guard: statically injecting the removed settingsScope service
    // failed the whole client boot (RendererStartupFailure) on DSH desktop.
    expect(mod.inject).not.toContain('settingsScope')
    expect(mod.inject).not.toContain('configForms')
  })

  it('registers the settings section on the new-generation surface', () => {
    const mod = loadClient()
    const forms = fakeConfigForms({
      status: 'ready',
      value: { autoAttach: true, adoptAliased: false, groups: [['/a', 'F:\\a']] },
      revision: 3,
      writable: true,
    })
    const host = fakeClientCtx({ configForms: forms.configForms })

    mod.apply(host.ctx)

    expect(host.probed).toContainEqual(['configForms'])
    expect(host.registrations.length).toBe(1)
    expect(host.registrations[0].spec).toEqual({
      name: 'settings.section',
      id: 'workspace-alias',
      order: 60,
      label: '工作区别名',
    })
    expect(typeof host.registrations[0].component).toBe('function')
    expect(forms.whileServed).toEqual([['workspace-alias']])
  })

  it('registers the settings section on the old-generation surface', () => {
    const mod = loadClient()
    const bound: unknown[] = []
    const controller = { subscribe: () => () => {}, getSnapshot: () => ({}), mutate: () => Promise.resolve(true) }
    const settingsScope = {
      bind: (options: unknown) => {
        bound.push(options)
        return controller
      },
    }
    const host = fakeClientCtx({ settingsScope })

    mod.apply(host.ctx)

    expect(bound).toEqual([{ namespace: 'workspace-alias' }])
    expect(host.registrations.length).toBe(1)
    expect(host.registrations[0].spec.id).toBe('workspace-alias')
  })

  it('registers nothing when the host has neither settings surface', () => {
    const mod = loadClient()
    const host = fakeClientCtx({})

    mod.apply(host.ctx)

    expect(host.registrations.length).toBe(0)
    expect(host.probed).toContainEqual(['configForms'])
    expect(host.probed).toContainEqual(['settingsScope'])
  })

  it('adapts the host form to the controller face the section consumes', () => {
    const mod = loadClient()
    const forms = fakeConfigForms({
      status: 'ready',
      value: { autoAttach: true, adoptAliased: true, groups: [['/a']] },
      revision: 7,
      writable: true,
    })
    const controller = mod.__test.adaptConfigForm(forms.form)

    expect(controller.getSnapshot()).toEqual({
      status: 'ready',
      value: { autoAttach: true, adoptAliased: true, groups: [['/a']] },
      revision: 7,
      writable: true,
    })

    // A namespace that exists but has no object value is not renderable: the
    // section must show its diagnostic branch instead of crashing on `.groups`.
    for (const bad of [null, undefined, [], 'nope']) {
      forms.setSnapshot({ status: 'ready', value: bad, revision: 7, writable: true })
      expect(controller.getSnapshot().status).toBe('unavailable')
      expect(controller.getSnapshot().value).toBeUndefined()
    }
    forms.setSnapshot({ status: 'loading', value: undefined, revision: undefined, writable: false })
    expect(controller.getSnapshot().status).toBe('loading')
    forms.setSnapshot({ status: 'ready', value: { autoAttach: false, groups: [] }, revision: 9, writable: false })
    expect(controller.getSnapshot()).toEqual({
      status: 'ready',
      value: { autoAttach: false, groups: [] },
      revision: 9,
      writable: false,
    })

    // Reads and writes both ride the host form.
    const listener = () => {}
    controller.subscribe(listener)
    expect(forms.listeners).toContain(listener)
    const ops = [{ op: 'set', path: ['autoAttach'], value: false }]
    void controller.mutate(ops)
    expect(forms.mutations).toEqual([{ ops, revision: undefined }])
  })

  it('ships the same file in lib/ as in client/ (build sync)', () => {
    const built = join(process.cwd(), 'lib', 'client.js')
    if (!existsSync(built)) return
    expect(readFileSync(built, 'utf8')).toBe(readFileSync(join(process.cwd(), 'client', 'client.js'), 'utf8'))
  })
})
