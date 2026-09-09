/**
 * Copy the hand-written client bundle into lib/ as part of the build.
 *
 * The client half (settings UI section) is NOT compiled by tsdown: it must
 * ship in the DSH client-module format (window.__ModuleLoader__.load wrapper)
 * consumed verbatim by the host's client-modules registry. Keeping it as a
 * raw file avoids any bundler transform that would strip the wrapper.
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(repoRoot, 'client', 'client.js')
const outDir = join(repoRoot, 'lib')

if (!existsSync(source)) {
  console.error('[sync-client] missing client/client.js — refusing to build')
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })
copyFileSync(source, join(outDir, 'client.js'))
console.log('[sync-client] client/client.js -> lib/client.js')
