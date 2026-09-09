/**
 * Cross-device workspace alias resolution (pure logic, unit-testable).
 *
 * A "group" is a list of paths that all refer to the same project directory on
 * different machines (e.g. `["/Volumes/Data/notes", "F:\\notes"]`, synced via
 * Syncthing). On a given machine, at most one member physically exists; when a
 * session header carries a foreign cwd (a path that does not resolve locally),
 * we resolve it to the group member that does exist, so the session's
 * canonical path lands on the local workspace record.
 * @module dsh-workspace-alias/alias
 */

import { homedir } from 'node:os'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One alias group: paths that all denote the same directory across devices. */
export type AliasGroup = readonly string[]

/** Durable shape of `<dshHome>/workspace-alias.json`. */
export interface AliasConfig {
  version: 1
  /** Synced-file friendly: relative-free, one group per project. */
  groups: readonly AliasGroup[]
  /**
   * When true (default), sessions whose cwd resolves only through an alias are
   * attached to the local workspace at startup. Sessions a user explicitly
   * detached are never foreign-cwd sessions, so auto-attach cannot fight
   * local detach intent.
   */
  autoAttach?: boolean
}

/** Normalize a path into a comparison key: separators unified, case-folded. */
export function pathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** `<dshHome>/workspace-alias.json` location (DSH_HOME wins, like the host). */
export function aliasConfigPath(dshHome?: string): string {
  return join(dshHomePath(), 'workspace-alias.json')
}

/** The dsh home directory (DSH_HOME wins, like the host). */
export function dshHomePath(dshHome?: string): string {
  return dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * Read and shape-validate the alias config; missing file means "no aliases".
 *
 * Tolerance policy (v0.2.4): one malformed group must not poison the whole
 * table — a group that is not an array of >= 1 paths is skipped and reported
 * through `onWarning` instead of failing the load. A single-member group is
 * legal (it documents a path that exists on one machine only) but can never
 * alias, so it warns. This matters because a thrown load at startup leaves
 * the config store on an empty default, and the stock entity write path then
 * prunes every foreign-cwd session from membership on its next reconcile —
 * an outage here is data-destructive, so the loader degrades gracefully.
 */
export async function loadAliasConfig(
  file = aliasConfigPath(),
  onWarning?: (message: string) => void,
): Promise<AliasConfig> {
  const warn = onWarning ?? (() => {})
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return { version: 1, groups: [], autoAttach: true }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`workspace-alias.json is not valid JSON: ${String(error)}`)
  }
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.groups)) {
    throw new Error('workspace-alias.json: "groups" must be an array of path arrays')
  }
  const groups: AliasGroup[] = []
  ;(obj.groups as unknown[]).forEach((group, index) => {
    if (!Array.isArray(group) || group.length < 1) {
      warn(`workspace-alias.json: group #${index} is not an array of >= 1 paths — skipped`)
      return
    }
    const members = group.map(String)
    if (members.length < 2) {
      warn(
        `workspace-alias.json: group #${index} (${members.join(', ')}) has a single member — ` +
          'loaded, but it can never alias to another machine',
      )
    }
    groups.push(members)
  })
  return {
    version: 1,
    groups,
    autoAttach: obj.autoAttach === undefined ? true : obj.autoAttach === true,
  }
}

/**
 * The shape exposed through the DSH settings service (the UI mirror layer).
 * Identical information to {@link AliasConfig} minus the `version` envelope:
 * the settings namespace stores only `{ autoAttach, groups }`.
 */
export interface AliasSettingsShape {
  autoAttach: boolean
  groups: string[][]
}

/** AliasConfig -> settings shape (identity mapping, defensive copies). */
export function toSettingsShape(config: AliasConfig): AliasSettingsShape {
  return {
    autoAttach: config.autoAttach ?? true,
    groups: config.groups.map((group) => [...group]),
  }
}

/**
 * Canonical string form of a settings shape, used to detect real changes
 * between the JSON file and the settings namespace (loop guard for the
 * two-way mirror). Rebuilds both sides through the same normalizer so key
 * order and array identity cannot produce phantom differences.
 */
export function canonicalShape(shape: unknown): string {
  const obj = (shape ?? {}) as Record<string, unknown>
  const groups = Array.isArray(obj.groups) ? obj.groups : []
  return JSON.stringify({
    autoAttach: obj.autoAttach === undefined ? true : obj.autoAttach === true,
    groups: groups.map((group: unknown) =>
      Array.isArray(group) ? group.map((member) => String(member)) : [String(group)],
    ),
  })
}

/**
 * Validate a settings-side value into {@link AliasSettingsShape}. Throws on
 * structurally invalid input — the caller must NOT write such data into the
 * JSON true source (an outage here is data-destructive, mirroring the
 * loader's tolerance rationale in reverse: garbage never replaces a good
 * table).
 */
export function fromSettingsShape(shape: unknown): AliasSettingsShape {
  if (shape === undefined || shape === null || typeof shape !== 'object') {
    // A null/undefined mirror value must NOT fall back to an empty default:
    // writing that over the JSON true source would wipe the shared table.
    throw new Error('settings value is not an object')
  }
  const obj = shape as Record<string, unknown>
  if (!Array.isArray(obj.groups)) {
    throw new Error('settings value: "groups" must be an array')
  }
  return {
    autoAttach: obj.autoAttach === undefined ? true : obj.autoAttach === true,
    groups: obj.groups.map((group: unknown, index: number) => {
      if (!Array.isArray(group) || group.length < 1) {
        throw new Error(`settings value: group #${index} must be an array of >= 1 paths`)
      }
      return group.map((member) => String(member))
    }),
  }
}

/**
 * Persist `config` as the JSON true source. Safety rails for UI-driven
 * writes: the previous content is kept as `<file>.bak` (a UI accident —
 * e.g. the settings page's reset — must not silently destroy a shared
 * table), and the write is atomic-ish (temp file + rename) so a concurrent
 * Syncthing read never observes a half-written file.
 */
export async function saveAliasConfig(file: string, config: AliasSettingsShape): Promise<void> {
  const body = JSON.stringify(
    { version: 1, groups: config.groups, autoAttach: config.autoAttach },
    null,
    2,
  )
  let previous: string | undefined
  try {
    previous = await readFile(file, 'utf8')
  } catch {
    // No previous content — nothing to back up.
  }
  if (previous !== undefined && previous !== body) {
    await writeFile(`${file}.bak`, previous, 'utf8')
  }
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, body + '\n', 'utf8')
  await rename(temp, file)
}

export interface AliasResolution {
  /** Canonical local path (fs.realpath of the resolved member). */
  path: string
  /** True when the input path did not resolve locally and an alias member was used. */
  aliased: boolean
}

/**
 * Resolve `cwd` to a canonical local path, falling back to the alias group.
 * `realpath` is the same fs.realpath canon the host workspace registry uses;
 * we only add the cross-device fallback layer on top of it.
 *
 * Resolution order:
 * 1. `realpath(cwd)` succeeds → that canonical path (normal local session).
 * 2. `cwd` matches a member of some group → try every *other* member; the
 *    first one that resolves wins (the locally-existing sibling).
 * 3. Nothing resolves → rethrow the original error (session stays ungrouped,
 *    identical to stock behavior).
 */
export async function aliasAwareRealpath(
  cwd: string,
  config: Pick<AliasConfig, 'groups'>,
  realpath: (path: string) => Promise<string>,
): Promise<AliasResolution> {
  try {
    return { path: await realpath(cwd), aliased: false }
  } catch (originalError) {
    const key = pathKey(cwd)
    for (const group of config.groups) {
      const members = group.map(pathKey)
      if (!members.includes(key)) continue
      for (let i = 0; i < group.length; i++) {
        if (members[i] === key) continue
        try {
          return { path: await realpath(group[i]), aliased: true }
        } catch {
          // Sibling not present on this machine either — keep trying.
        }
      }
    }
    throw originalError
  }
}

/**
 * The deterministic rewrite target for stored-header migration: the FIRST
 * member of the matching group that is an absolute POSIX path (pure string
 * test — machine-independent). Every POSIX machine therefore rewrites the
 * same foreign cwd to the same string and the same storage bucket, with no
 * "first machine to boot wins" race. Grouping keeps using the
 * locally-existing member via {@link aliasAwareRealpath}; only the on-disk
 * header repair uses this target.
 *
 * Returns null when the cwd matches no group, or the group has no POSIX
 * member (no string a POSIX machine could normalize to — leave as-is).
 */
export function canonicalRewriteTarget(
  cwd: string,
  config: Pick<AliasConfig, 'groups'>,
): string | null {
  const key = pathKey(cwd)
  for (const group of config.groups) {
    const members = group.map(pathKey)
    if (!members.includes(key)) continue
    for (const member of group) {
      if (member.startsWith('/')) return member
    }
    return null
  }
  return null
}
