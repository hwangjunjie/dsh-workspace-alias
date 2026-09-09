/**
 * Deploy built plugin to the DSH runtime plugin directory.
 *
 * ~/.dsh/plugin-dist/<name>/ is the official local-plugin install location:
 * ~/.dsh/profiles/web/package.json references it via "link:../../plugin-dist/<name>",
 * and ~/.dsh/sync-ignore.txt whitelists it for cross-machine (Syncthing) distribution.
 *
 * Copies the publishable payload (lib/, cordis.patch.yml, package.json, README.md,
 * NOTICE) from the repo to the install target. Run after `npm run build`.
 */
import { cpSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const target = join(homedir(), '.dsh', 'plugin-dist', pkg.name)

const payload = ['lib', 'cordis.patch.yml', 'package.json', 'README.md', 'NOTICE']
const missing = payload.filter((f) => !existsSync(join(repoRoot, f)))
if (missing.length > 0) {
  console.error(`[deploy] missing build artifacts: ${missing.join(', ')} — run "npm run build" first`)
  process.exit(1)
}

mkdirSync(target, { recursive: true })
for (const item of payload) {
  cpSync(join(repoRoot, item), join(target, item), { recursive: true, force: true })
  console.log(`[deploy] ${item} -> ${target}`)
}
console.log(`[deploy] ${pkg.name}@${pkg.version} deployed`)
