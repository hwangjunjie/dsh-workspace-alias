import { describe, expect, it } from 'vitest'
import {
  aliasAwareRealpath,
  canonicalShape,
  fromSettingsShape,
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
    expect(c).toEqual({ version: 1, groups: [], autoAttach: true })
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
  it('toSettingsShape copies groups and defaults autoAttach', () => {
    const s = toSettingsShape({ version: 1, groups: [['/a', 'F:\\b']] })
    expect(s).toEqual({ autoAttach: true, groups: [['/a', 'F:\\b']] })
  })

  it('canonicalShape is order-insensitive for keys but not for group order', () => {
    expect(canonicalShape({ groups: [['/a', '/b']], autoAttach: false })).toBe(
      canonicalShape({ autoAttach: false, groups: [['/a', '/b']] }),
    )
    expect(canonicalShape({ groups: [['/a', '/b']] })).not.toBe(
      canonicalShape({ groups: [['/b', '/a']] }),
    )
  })

  it('fromSettingsShape round-trips a valid shape', () => {
    const shape = { autoAttach: false, groups: [['/Volumes/Data/notes', 'F:\\notes']] }
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
    await saveAliasConfig(file, { autoAttach: true, groups: [['/a', 'F:\\b']] })
    const read = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(read).toEqual({ version: 1, groups: [['/a', 'F:\\b']], autoAttach: true })
    const backup = JSON.parse(await fs.readFile(`${file}.bak`, 'utf8'))
    expect(backup.groups).toEqual([['/old']])
  })

  it('round-trips through loadAliasConfig', async () => {
    const file = '/tmp/dsh-alias-roundtrip.json'
    await saveAliasConfig(file, { autoAttach: false, groups: [['/x', '/y']] })
    const c = await loadAliasConfig(file)
    expect(c).toEqual({ version: 1, groups: [['/x', '/y']], autoAttach: false })
  })
})
