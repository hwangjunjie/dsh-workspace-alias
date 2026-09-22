import { describe, expect, it } from 'vitest'
import {
  aliasAwareRealpath,
  aliasMemberKeys,
  canonicalShape,
  fromSettingsShape,
  isAliasMemberPath,
  loadAliasConfig,
  pathKey,
  saveAliasConfig,
  toSettingsShape,
} from '../src/alias.ts'

/** Fake realpath: only these paths "exist" locally, returned verbatim-canon. */
function fakeRealpath(existing: Set<string>) {
  return async (p: string): Promise<string> => {
    if (existing.has(pathKey(p))) return p
    throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${p}'`), {
      code: 'ENOENT',
    })
  }
}

const config = {
  groups: [['/Volumes/Data/notes', 'F:\\notes']],
}

describe('pathKey', () => {
  it('unifies separators, case, and trailing slashes', () => {
    expect(pathKey('F:\\Notes\\')).toBe('f:/notes')
    expect(pathKey('/Volumes/Data/notes')).toBe('/volumes/data/notes')
  })
})

describe('aliasAwareRealpath', () => {
  it('uses plain realpath when the cwd exists locally', async () => {
    const rp = fakeRealpath(new Set(['/volumes/data/notes']))
    const r = await aliasAwareRealpath('/Volumes/Data/notes', config, rp)
    expect(r).toEqual({ path: '/Volumes/Data/notes', aliased: false })
  })

  it('resolves a foreign cwd through its alias group (Windows side)', async () => {
    // On Windows only F:\notes exists; the Mac-synced cwd does not.
    const rp = fakeRealpath(new Set(['f:/notes']))
    const r = await aliasAwareRealpath('/Volumes/Data/notes', config, rp)
    expect(r).toEqual({ path: 'F:\\notes', aliased: true })
  })

  it('resolves a foreign cwd through its alias group (Mac side)', async () => {
    const rp = fakeRealpath(new Set(['/volumes/data/notes']))
    const r = await aliasAwareRealpath('F:\\notes', config, rp)
    expect(r).toEqual({ path: '/Volumes/Data/notes', aliased: true })
  })

  it('rethrows the original error when no sibling exists', async () => {
    const rp = fakeRealpath(new Set())
    await expect(aliasAwareRealpath('/Volumes/Data/notes', config, rp)).rejects.toThrow('ENOENT')
  })

  it('passes through unrelated failing cwds untouched', async () => {
    const rp = fakeRealpath(new Set())
    await expect(aliasAwareRealpath('/some/other/project', config, rp)).rejects.toThrow('ENOENT')
  })

  it('handles both spellings of the same Windows path', async () => {
    const rp = fakeRealpath(new Set(['f:/notes']))
    const fwd = await aliasAwareRealpath('F:/notes', config, rp)
    expect(fwd.aliased).toBe(false)
    const back = await aliasAwareRealpath('F:\\notes', config, rp)
    expect(back.aliased).toBe(false)
  })
})

describe('loadAliasConfig', () => {
  it('returns an empty config when the file is missing', async () => {
    const c = await loadAliasConfig('/nonexistent/workspace-alias.json')
    expect(c).toEqual({ version: 1, groups: [], autoAttach: true, adoptAliased: false })
  })

  it('parses the adoptAliased opt-in (defaults to false)', async () => {
    const fs = await import('node:fs/promises')
    const file = '/tmp/dsh-alias-adopt.json'
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, groups: [['/a', 'F:\\b']], adoptAliased: true }),
    )
    const on = await loadAliasConfig(file)
    expect(on.adoptAliased).toBe(true)
    await fs.writeFile(file, JSON.stringify({ version: 1, groups: [['/a', 'F:\\b']] }))
    const off = await loadAliasConfig(file)
    expect(off.adoptAliased).toBe(false)
  })

  it('parses a valid table', async () => {
    const json = JSON.stringify({
      version: 1,
      groups: [['/Volumes/Data/notes', 'F:\\notes']],
    })
    const blob = new Blob([json])
    const file = await import('node:fs/promises').then(fs =>
      fs.writeFile('/tmp/dsh-alias-test.json', json),
    )
    void file
    void blob
    const c = await loadAliasConfig('/tmp/dsh-alias-test.json')
    expect(c.groups).toHaveLength(1)
    expect(c.autoAttach).toBe(true)
  })

  it('skips malformed groups with a warning instead of failing the load', async () => {
    const fs = await import('node:fs/promises')
    const warnings: string[] = []
    await fs.writeFile(
      '/tmp/dsh-alias-bad.json',
      JSON.stringify({
        version: 1,
        groups: [['/only/one'], 'not-an-array', ['/Volumes/Data/notes', 'F:\\notes']],
      }),
    )
    const c = await loadAliasConfig('/tmp/dsh-alias-bad.json', (m) => warnings.push(m))
    // The valid group survives; the malformed ones are skipped.
    expect(c.groups).toEqual([['/only/one'], ['/Volumes/Data/notes', 'F:\\notes']])
    expect(warnings).toHaveLength(2)
  })

  it('accepts a single-member group but warns it can never alias', async () => {
    const fs = await import('node:fs/promises')
    const warnings: string[] = []
    await fs.writeFile('/tmp/dsh-alias-single.json', JSON.stringify({ version: 1, groups: [['/Users/zzzh']] }))
    const c = await loadAliasConfig('/tmp/dsh-alias-single.json', (m) => warnings.push(m))
    expect(c.groups).toEqual([['/Users/zzzh']])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('single member')
  })
})

describe('settings shape mirror', () => {
  it('toSettingsShape copies groups and defaults autoAttach/adoptAliased', () => {
    const s = toSettingsShape({ version: 1, groups: [['/a', 'F:\\b']] })
    expect(s).toEqual({ autoAttach: true, adoptAliased: false, groups: [['/a', 'F:\\b']] })
    expect(
      toSettingsShape({ version: 1, groups: [], adoptAliased: true }).adoptAliased,
    ).toBe(true)
  })

  it('canonicalShape is order-insensitive for keys but not for group order', () => {
    expect(canonicalShape({ groups: [['/a', '/b']], autoAttach: false })).toBe(
      canonicalShape({ autoAttach: false, groups: [['/a', '/b']] }),
    )
    expect(canonicalShape({ groups: [['/a', '/b']] })).not.toBe(
      canonicalShape({ groups: [['/b', '/a']] }),
    )
  })

  it('canonicalShape distinguishes adoptAliased from its default', () => {
    expect(canonicalShape({ groups: [], adoptAliased: true })).not.toBe(
      canonicalShape({ groups: [] }),
    )
    expect(canonicalShape({ groups: [], adoptAliased: false })).toBe(
      canonicalShape({ groups: [] }),
    )
  })

  it('fromSettingsShape round-trips a valid shape', () => {
    const shape = { autoAttach: false, adoptAliased: true, groups: [['/Volumes/Data/notes', 'F:\\notes']] }
    expect(fromSettingsShape(shape)).toEqual(shape)
  })

  it('fromSettingsShape rejects structurally invalid values instead of writing them', () => {
    expect(() => fromSettingsShape({ groups: 'nope' })).toThrow('must be an array')
    expect(() => fromSettingsShape({ groups: [[]] })).toThrow('>= 1 paths')
    expect(() => fromSettingsShape(null)).toThrow('not an object')
  })
})

describe('saveAliasConfig', () => {
  it('writes the version envelope and keeps a .bak of the previous content', async () => {
    const fs = await import('node:fs/promises')
    const file = '/tmp/dsh-alias-save.json'
    await fs.writeFile(file, JSON.stringify({ version: 1, groups: [['/old']], autoAttach: false }))
    await saveAliasConfig(file, { autoAttach: true, adoptAliased: false, groups: [['/a', 'F:\\b']] })
    const read = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(read).toEqual({
      version: 1,
      groups: [['/a', 'F:\\b']],
      autoAttach: true,
      adoptAliased: false,
    })
    const backup = JSON.parse(await fs.readFile(`${file}.bak`, 'utf8'))
    expect(backup.groups).toEqual([['/old']])
  })

  it('round-trips through loadAliasConfig', async () => {
    const file = '/tmp/dsh-alias-roundtrip.json'
    await saveAliasConfig(file, { autoAttach: false, adoptAliased: true, groups: [['/x', '/y']] })
    const c = await loadAliasConfig(file)
    expect(c).toEqual({ version: 1, groups: [['/x', '/y']], autoAttach: false, adoptAliased: true })
  })
})

describe('isAliasMemberPath', () => {
  const config = { groups: [['/Volumes/Data/notes', 'F:\\notes']] }

  it('matches a declared member across separator/case/trailing-slash noise', () => {
    expect(isAliasMemberPath('/Volumes/Data/notes', config)).toBe(true)
    expect(isAliasMemberPath('/volumes/data/notes/', config)).toBe(true)
    expect(isAliasMemberPath('F:\\Notes\\', config)).toBe(true)
  })

  it('rejects undeclared paths and the empty string', () => {
    expect(isAliasMemberPath('/Volumes/Data/projects', config)).toBe(false)
    expect(isAliasMemberPath('', config)).toBe(false)
  })
})

describe('aliasMemberKeys', () => {
  const config = { groups: [['/tmp/dsh-notes', 'F:\\notes']] }
  // The registry side is always resolved (/tmp -> /private/tmp on macOS), so a
  // literal-only member key would never match a real workspace path.
  const rp = fakeRealpath(new Set(['/private/tmp/dsh-notes']))
  const canonical = async (p: string): Promise<string> => {
    if (p.startsWith('/tmp/')) return `/private${p}`
    return rp(p)
  }

  it('covers both the literal member and its realpath form', async () => {
    const keys = await aliasMemberKeys(config, canonical)
    expect(keys.has(pathKey('/tmp/dsh-notes'))).toBe(true)
    expect(keys.has(pathKey('/private/tmp/dsh-notes'))).toBe(true)
    expect(keys.has(pathKey('F:\\Notes\\'))).toBe(true)
  })

  it('still contributes literal keys for members that do not exist here', async () => {
    const keys = await aliasMemberKeys({ groups: [['F:\\notes']] }, canonical)
    expect(keys).toEqual(new Set([pathKey('F:\\notes')]))
  })

  it('returns an empty set for an empty configuration', async () => {
    expect(await aliasMemberKeys({ groups: [] }, canonical)).toEqual(new Set())
  })
})
