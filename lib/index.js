import { mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { Service } from "@deepseek-ai/cordis";
import { WorkspaceRegistry, realpathNormalize } from "@deepseek-ai/dsh-workspace";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { watch } from "node:fs";
import z from "@deepseek-ai/schemastery";
//#region src/alias.ts
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
/** Normalize a path into a comparison key: separators unified, case-folded. */
function pathKey(path) {
	return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
/** `<dshHome>/workspace-alias.json` location (DSH_HOME wins, like the host). */
function aliasConfigPath(dshHome) {
	return join(dshHomePath(), "workspace-alias.json");
}
/** The dsh home directory (DSH_HOME wins, like the host). */
function dshHomePath(dshHome) {
	return dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
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
async function loadAliasConfig(file = aliasConfigPath(), onWarning) {
	const warn = onWarning ?? (() => {});
	let raw;
	try {
		raw = await readFile(file, "utf8");
	} catch {
		return {
			version: 1,
			groups: [],
			autoAttach: true,
			adoptAliased: false
		};
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`workspace-alias.json is not valid JSON: ${String(error)}`);
	}
	const obj = parsed;
	if (!Array.isArray(obj.groups)) throw new Error("workspace-alias.json: \"groups\" must be an array of path arrays");
	const groups = [];
	obj.groups.forEach((group, index) => {
		if (!Array.isArray(group) || group.length < 1) {
			warn(`workspace-alias.json: group #${index} is not an array of >= 1 paths — skipped`);
			return;
		}
		const members = group.map(String);
		if (members.length < 2) warn(`workspace-alias.json: group #${index} (${members.join(", ")}) has a single member — loaded, but it can never alias to another machine`);
		groups.push(members);
	});
	return {
		version: 1,
		groups,
		autoAttach: obj.autoAttach === void 0 ? true : obj.autoAttach === true,
		adoptAliased: obj.adoptAliased === true
	};
}
/** AliasConfig -> settings shape (identity mapping, defensive copies). */
function toSettingsShape(config) {
	return {
		autoAttach: config.autoAttach ?? true,
		adoptAliased: config.adoptAliased ?? false,
		groups: config.groups.map((group) => [...group])
	};
}
/**
* Canonical string form of a settings shape, used to detect real changes
* between the JSON file and the settings namespace (loop guard for the
* two-way mirror). Rebuilds both sides through the same normalizer so key
* order and array identity cannot produce phantom differences.
*/
function canonicalShape(shape) {
	const obj = shape ?? {};
	const groups = Array.isArray(obj.groups) ? obj.groups : [];
	return JSON.stringify({
		autoAttach: obj.autoAttach === void 0 ? true : obj.autoAttach === true,
		adoptAliased: obj.adoptAliased === true,
		groups: groups.map((group) => Array.isArray(group) ? group.map((member) => String(member)) : [String(group)])
	});
}
/**
* Validate a settings-side value into {@link AliasSettingsShape}. Throws on
* structurally invalid input — the caller must NOT write such data into the
* JSON true source (an outage here is data-destructive, mirroring the
* loader's tolerance rationale in reverse: garbage never replaces a good
* table).
*/
function fromSettingsShape(shape) {
	if (shape === void 0 || shape === null || typeof shape !== "object") throw new Error("settings value is not an object");
	const obj = shape;
	if (!Array.isArray(obj.groups)) throw new Error("settings value: \"groups\" must be an array");
	return {
		autoAttach: obj.autoAttach === void 0 ? true : obj.autoAttach === true,
		adoptAliased: obj.adoptAliased === true,
		groups: obj.groups.map((group, index) => {
			if (!Array.isArray(group) || group.length < 1) throw new Error(`settings value: group #${index} must be an array of >= 1 paths`);
			return group.map((member) => String(member));
		})
	};
}
/**
* Persist `config` as the JSON true source. Safety rails for UI-driven
* writes: the previous content is kept as `<file>.bak` (a UI accident —
* e.g. the settings page's reset — must not silently destroy a shared
* table), and the write is atomic-ish (temp file + rename) so a concurrent
* Syncthing read never observes a half-written file.
*/
async function saveAliasConfig(file, config) {
	const body = JSON.stringify({
		version: 1,
		groups: config.groups,
		autoAttach: config.autoAttach,
		adoptAliased: config.adoptAliased
	}, null, 2);
	let previous;
	try {
		previous = await readFile(file, "utf8");
	} catch {}
	if (previous !== void 0 && previous !== body) await writeFile(`${file}.bak`, previous, "utf8");
	const temp = `${file}.${process.pid}.tmp`;
	await writeFile(temp, body + "\n", "utf8");
	await rename(temp, file);
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
async function aliasAwareRealpath(cwd, config, realpath) {
	try {
		return {
			path: await realpath(cwd),
			aliased: false
		};
	} catch (originalError) {
		const key = pathKey(cwd);
		for (const group of config.groups) {
			const members = group.map(pathKey);
			if (!members.includes(key)) continue;
			for (let i = 0; i < group.length; i++) {
				if (members[i] === key) continue;
				try {
					return {
						path: await realpath(group[i]),
						aliased: true
					};
				} catch {}
			}
		}
		throw originalError;
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
function canonicalRewriteTarget(cwd, config) {
	const key = pathKey(cwd);
	for (const group of config.groups) {
		if (!group.map(pathKey).includes(key)) continue;
		for (const member of group) if (member.startsWith("/")) return member;
		return null;
	}
	return null;
}
/**
* Comparison keys for every declared alias member, literal AND resolved: the
* key of the path as the user wrote it plus, when the member exists on this
* machine, the key of its realpath.
*
* Both are needed because the two sides are normalized differently. Workspace
* records and indexed session paths hold already-resolved paths, while a
* declared member may sit behind a symlinked prefix (`/tmp` ->
* `/private/tmp`, a symlinked mount point) or, conversely, be the resolved
* form while the index holds the literal one. Comparing keys without
* realpathing the members would therefore miss exactly the sessions the
* adoption pass exists to recognize. Members that do not resolve locally
* contribute their literal key only.
*/
async function aliasMemberKeys(config, realpath) {
	const keys = /* @__PURE__ */ new Set();
	for (const group of config.groups) for (const member of group) {
		const literal = pathKey(member);
		if (literal.length > 0) keys.add(literal);
		try {
			const resolved = pathKey(await realpath(member));
			if (resolved.length > 0) keys.add(resolved);
		} catch {}
	}
	return keys;
}
//#endregion
//#region src/migrate.ts
/**
* One-time header cwd compat migration (v0.2).
*
* dsh-session validates every stored session header with the *platform*
* `path.isAbsolute` before serving its history. A session synced from
* Windows carries a Windows cwd (`F:\notes`), which is NOT absolute on
* POSIX — the gateway then refuses to load the history ("session header
* cwd must be an absolute path"). The reverse direction is fine: win32
* `isAbsolute` accepts POSIX paths, so Mac-originated headers load on
* Windows as-is.
*
* Because of that asymmetry, normalizing a foreign header's cwd to the
* LOCAL alias member's canonical path is stable in both directions:
* - POSIX form passes validation on macOS AND on Windows;
* - each machine only rewrites headers that FAIL its own isAbsolute check,
*   so after one rewrite the file never changes again (no sync ping-pong);
* - workspace grouping keeps working: the rewritten cwd is the local
*   sibling's realpath, and the other machine resolves it back through the
*   alias group.
*
* But rewriting the cwd invalidates the on-disk *location*: the storage
* backend derives the bucket directory from the header cwd (projectKey) and
* re-derives it on every load (`assertStoredIdentity`), so a rewritten
* session must also MOVE from the old bucket to the new one — otherwise the
* whole plugin tree fails with "header id ... and cwd identify ...". This
* module therefore also relocates session directories whose parent bucket
* no longer matches `projectKey(header.cwd)`. A move is skipped when the
* two spellings resolve to the same physical directory (case variants on
* case-insensitive filesystems, mirroring the stock `sameFile` fallback).
*
* File format: `<dshHome>/sessions/<bucket>/<id>/session[.vN].jsonl[.zstd]`,
* a zstd stream whose first frame holds the header JSON line; later events
* are appended as additional frames. Every scan resolves the NEWEST canonical
* generation (generation 0 = `session.jsonl`, N = `session.vN.jsonl`) — the
* one `resolveGenerationInDirectory` selects — because a stale generation-0
* stub left beside a v3 log must never be the file we rewrite: that would
* desync the authoritative log from its bucket instead of healing it. The
* rewrite replaces frame 1 and keeps every subsequent frame byte-identical,
* so dsh's append history is preserved untouched.
* @module dsh-workspace-alias/migrate
*/
/**
* The bucket directory key for a project path — ported verbatim from
* `dsh-session-persistence-jsonl` (`projectKey`), because the storage
* identity check re-derives the session's physical location from the header
* cwd on every load and our rewrite must land the directory where the
* checker expects it. Separators (`/`, `\`, `:`) collapse to `-`, safe
* characters pass through, anything else becomes `~XXXX` hex; the result is
* stripped of leading dashes, capped at 251 chars and wrapped in `--`.
*/
function projectKey(cwd) {
	if (cwd.length === 0) throw new Error("cannot encode an empty project path");
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const ch = cwd[i];
		const code = cwd.charCodeAt(i);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}
/**
* Canonical generation basename -> version, or undefined when the name is not
* a canonical generation (temporary/foreign files). Ported from
* `dsh-session-format`: generation 0 is `session.jsonl`, generation N is
* `session.vN.jsonl`; the `.zstd` compression suffix is optional (plaintext).
*/
function parseGenerationLogName(name) {
	const match = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(name);
	if (match === null) return void 0;
	return match[1] === void 0 ? 0 : Number(match[1]);
}
/**
* Resolve the newest canonical generation inside one session directory — the
* file `dsh-session-persistence-jsonl`'s `resolveGenerationInDirectory`
* selects (highest version wins). Returns undefined for a directory storing
* none (not a session directory, or only temporary files).
*/
async function newestGenerationLog(dirPath) {
	let entries;
	try {
		entries = await readdir(dirPath, { withFileTypes: true });
	} catch {
		return;
	}
	let best;
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const version = parseGenerationLogName(entry.name);
		if (version === void 0) continue;
		if (best === void 0 || version > best.version) best = {
			name: entry.name,
			file: join(dirPath, entry.name),
			version,
			compressed: entry.name.endsWith(".zstd")
		};
	}
	return best;
}
/** Size of the zstd magic number. */
const ZSTD_MAGIC = 4247762216;
/**
* Exact compressed size of the first zstd frame, by walking the frame
* structure (magic + header [+ window descriptor] + block chain [+
* checksum]); block headers carry their payload size, so no decoding is
* needed. Throws on anything that is not a well-formed frame start.
*/
function zstdFrameSize(buf, offset = 0) {
	let p = offset;
	if (buf.readUInt32LE(p) !== ZSTD_MAGIC) throw new Error(`not a zstd frame at offset ${offset}`);
	p += 4;
	const fhd = buf[p++];
	const fcsFlag = fhd >> 6;
	const singleSegment = fhd >> 5 & 1;
	const checksum = fhd >> 2 & 1;
	const dictIdSize = [
		0,
		1,
		2,
		4
	][fhd & 3];
	const fcsSize = fcsFlag === 0 ? singleSegment ? 1 : 0 : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
	if (!singleSegment) p += 1;
	p += dictIdSize + fcsSize;
	for (;;) {
		const bh = buf[p] | buf[p + 1] << 8 | buf[p + 2] << 16;
		p += 3;
		const type = bh >> 1 & 3;
		const size = bh >> 3;
		if (type === 1) p += 1;
		else if (type === 3) throw new Error(`reserved block type at offset ${p - 3}`);
		else p += size;
		if (bh & 1) break;
	}
	if (checksum) p += 4;
	return p - offset;
}
/** Parse and shape-check the header JSON line of a stored session file. */
function parseHeaderLine(frame1Text) {
	const newline = frame1Text.indexOf("\n");
	const line = newline === -1 ? frame1Text : frame1Text.slice(0, newline);
	try {
		const obj = JSON.parse(line);
		if (obj.type !== "session" || typeof obj.id !== "string") return null;
		return obj;
	} catch {
		return null;
	}
}
/**
* Scan every stored session under `<dshHome>/sessions` and rewrite headers
* whose cwd fails the platform `isAbsolute` check but resolves through an
* alias group. Everything else is left byte-identical.
*/
async function migrateSessionHeaders(opts) {
	const report = {
		scanned: 0,
		rewritten: [],
		moved: [],
		unresolvable: [],
		errors: [],
		unsupportedRuntime: false
	};
	if (typeof zstdDecompressSync !== "function" || typeof zstdCompressSync !== "function") {
		report.unsupportedRuntime = true;
		return report;
	}
	const sessionsDir = join(opts.dshHome, "sessions");
	let buckets;
	try {
		buckets = (await readdir(sessionsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return report;
	}
	for (const bucket of buckets) {
		const bucketDir = join(sessionsDir, bucket);
		let ids;
		try {
			ids = (await readdir(bucketDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
		} catch {
			continue;
		}
		for (const id of ids) {
			const generation = await newestGenerationLog(join(bucketDir, id));
			if (generation === void 0) continue;
			const file = generation.file;
			report.scanned++;
			let buf;
			try {
				buf = await readFile(file);
			} catch {
				report.scanned--;
				continue;
			}
			if (!generation.compressed) {
				report.scanned--;
				report.errors.push(`${id}: newest generation '${generation.name}' is not zstd-compressed`);
				continue;
			}
			try {
				const frame1Size = zstdFrameSize(buf);
				const frame1Text = zstdDecompressSync(buf.subarray(0, frame1Size)).toString("utf8");
				const header = parseHeaderLine(frame1Text);
				if (!header) {
					report.errors.push(`${id}: header line is not a session header`);
					continue;
				}
				if (typeof header.cwd !== "string") continue;
				let cwd = header.cwd;
				if (!isAbsolute(cwd)) {
					const target = canonicalRewriteTarget(cwd, opts.config);
					if (!target) {
						report.unresolvable.push(`${id}: cwd '${cwd}' matches a group with no POSIX member`);
						continue;
					}
					const newline = frame1Text.indexOf("\n");
					const newHeader = JSON.stringify({
						...header,
						cwd: target
					});
					const newFrame1Text = newline === -1 ? newHeader : newHeader + frame1Text.slice(newline);
					const newBuf = Buffer.concat([zstdCompressSync(Buffer.from(newFrame1Text, "utf8")), buf.subarray(frame1Size)]);
					const tmp = `${file}.alias-tmp`;
					await writeFile(tmp, newBuf);
					await rename(tmp, file);
					cwd = target;
					report.rewritten.push({
						session: id,
						from: header.cwd,
						to: target
					});
				}
				const sessionDirPath = dirname(file);
				const expectedBucket = projectKey(cwd);
				if ((dirname(sessionDirPath).split("/").pop() ?? "") === expectedBucket) continue;
				const expectedParent = join(sessionsDir, expectedBucket);
				try {
					const [actualReal, expectedReal] = await Promise.all([realpath(dirname(sessionDirPath)), realpath(expectedParent)]);
					if (actualReal === expectedReal) continue;
				} catch {}
				const targetDir = join(expectedParent, id);
				try {
					await stat(targetDir);
					report.errors.push(`${id}: cannot move to ${expectedBucket}: target already exists`);
					continue;
				} catch {}
				await mkdir(expectedParent, { recursive: true });
				await rename(sessionDirPath, targetDir);
				report.moved.push(`${id}: ${dirname(sessionDirPath)} -> ${targetDir}`);
			} catch (error) {
				report.errors.push(`${id}: ${String(error)}`);
			}
		}
	}
	if (report.rewritten.length > 0) opts.log?.(`migrated ${report.rewritten.length} session header(s) to local paths: ` + report.rewritten.map((r) => `${r.session} (${r.from} -> ${r.to})`).join(", "));
	if (report.moved.length > 0) opts.log?.(`relocated ${report.moved.length} session director(y/ies) to cwd-derived buckets: ` + report.moved.join(", "));
	return report;
}
//#endregion
//#region src/store.ts
/**
* Watches `<dshHome>/workspace-alias.json` and hands out the current table.
* A missing file is a valid "no aliases" state (the watcher still listens so
* creating the file later takes effect without a restart).
* @module dsh-workspace-alias/store
*/
var AliasConfigStore = class {
	config = {
		version: 1,
		groups: [],
		autoAttach: true,
		adoptAliased: false
	};
	/** Canonical snapshot of {@link config}; detects real changes on reload. */
	snapshot = JSON.stringify(this.config);
	started = false;
	/** Warnings and load errors, drained and logged by Service.init. */
	diagnostics = [];
	/**
	* Invoked after every reload that actually changed the table. The
	* settings bridge assigns this to push external (synced / hand-edited)
	* changes into the settings-UI mirror; absent bridge = no-op.
	*/
	onChange = () => {};
	async start() {
		for (let attempt = 1;; attempt++) try {
			await this.reload();
			break;
		} catch {
			if (attempt >= 3) break;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		if (this.started) return;
		this.started = true;
		const file = aliasConfigPath();
		try {
			watch(file, { persistent: false }, () => {
				this.reload();
			}).on("error", () => {});
		} catch {}
	}
	async reload() {
		let next;
		try {
			next = await loadAliasConfig(aliasConfigPath(), (message) => {
				this.diagnostics.push(message);
			});
		} catch (error) {
			this.diagnostics.push(`alias config ignored: ${String(error)}`);
			console.warn("[dsh-workspace-alias] alias config ignored:", String(error));
			return;
		}
		const nextSnapshot = JSON.stringify(next);
		if (nextSnapshot === this.snapshot) return;
		this.config = next;
		this.snapshot = nextSnapshot;
		this.onChange();
	}
	/** Hand collected warnings/errors to the caller for ctx.logger output. */
	drainDiagnostics() {
		const drained = this.diagnostics;
		this.diagnostics = [];
		return drained;
	}
	get current() {
		return this.config;
	}
};
//#endregion
//#region src/settings.ts
/** Settings namespace owned by this plugin (lowercase-hyphenated per host). */
const ALIAS_SETTINGS_NAMESPACE = "workspace-alias";
/**
* Schema rendered by the settings page. Field order matters: the resolved
* value's key order follows it, keeping `canonicalShape()` comparisons
* stable against `toSettingsShape()` output.
*/
const AliasSettingsSchema = z.object({
	autoAttach: z.boolean().default(true).description("启动时把经别名解析的跨机会话自动附加到本地 workspace"),
	adoptAliased: z.boolean().default(false).description("启动时把「cwd 命中别名组、但当前没有任何 workspace 归属」的存量会话附加到对应 workspace。用于修复历史遗留的未分组会话（早期版本已把 header 改写成本机路径的会话，无法再被识别为跨机来源）。注意：手动 detach 不留墓碑，开启后别名项目里被刻意移出的会话会在下次启动被重新挂上。"),
	groups: z.array(z.array(z.string())).description("别名组：每组内的路径指向不同机器上的同一个项目目录（如 macOS /Volumes/Data/notes 与 Windows F:\\notes）。本机不存在的成员用于解析从其他机器同步来的会话。")
});
const HOST_SETTINGS_ARE_CONFIG_BACKED = typeof z.boolean().volatile === "function";
/** Apply the `.volatile()` marker when the host's schemastery supports it. */
function volatileField(schema) {
	if (!HOST_SETTINGS_ARE_CONFIG_BACKED) return schema;
	return schema.volatile();
}
/**
* Schema of the plugin entry's own config on DSH >= 0.2.0-rc, where settings
* pages are served by the host from the loader entry (see
* {@link wireAliasConfigBridge}). Every field is `.volatile()`: editing one
* commits the new value into the running plugin instead of remounting it,
* which is what keeps `workspace-alias.json` writes idempotent while the
* settings page stays open.
*/
const AliasSettingsConfig = z.object({
	autoAttach: volatileField(z.boolean().default(true)).description("启动时把经别名解析的跨机会话自动附加到本地 workspace"),
	adoptAliased: volatileField(z.boolean().default(false)).description("启动时把 cwd 命中别名组的存量会话附加到对应 workspace"),
	groups: volatileField(z.array(z.array(z.string())).default([])).description("别名组：组内路径指向不同机器上的同一个项目目录")
});
/**
* Wire the JSON <-> settings mirror for hosts whose settings pages are built
* from the plugin entry's own config (DSH >= 0.2.0-rc: `settings.register` was
* removed, pages are served by `@deepseek-ai/dsh-settings` from the loader
* entry's `.volatile()` fields, and edits are persisted through
* `configEditor.edit`).
*
* `refs` are the per-field config references the loader hands to the plugin
* constructor (see `AliasSettingsConfig`); they are the live view of the
* profile-side settings document. When the host has no such surface (fields
* are not references, no config editor) this is a no-op and the older
* namespace bridge — or hand-edited JSON — stays in charge.
*
* Same two-way contract as {@link wireAliasSettingsBridge}: JSON is the true
* source, the settings document is the mirror, and `canonicalShape()` string
* comparison against `lastMirror` stops each direction from echoing the other.
*/
function wireAliasConfigBridge(ctx, store, refs, afterChange) {
	const anyCtx = ctx;
	const groupsRef = refs?.groups;
	if (typeof groupsRef?.get !== "function") return;
	const logger = anyCtx.logger;
	const warn = (message) => {
		logger?.warn?.(`[dsh-workspace-alias] ${message}`);
	};
	let lastMirror = canonicalShape(toSettingsShape(store.current));
	let writeChain = Promise.resolve();
	let pushed = false;
	/** Write the mirror value into the profile settings document. */
	const pushToConfig = async (shape) => {
		const editor = typeof anyCtx.get === "function" ? anyCtx.get("configEditor") : void 0;
		const entry = anyCtx.fiber?.entry;
		if (typeof editor?.edit !== "function" || entry === void 0) throw new Error("host exposes no configEditor for the settings document");
		await editor.edit(entry, () => ({
			autoAttach: shape.autoAttach === true,
			adoptAliased: shape.adoptAliased === true,
			groups: shape.groups.map((group) => [...group])
		}));
	};
	const autoRef = refs?.autoAttach;
	const adoptRef = refs?.adoptAliased;
	const readBool = (ref, fallback) => {
		const value = ref?.get?.();
		return value === void 0 ? fallback : value === true;
	};
	const readConfigShape = () => ({
		autoAttach: readBool(autoRef, true),
		adoptAliased: readBool(adoptRef, false),
		groups: (groupsRef.get() ?? []).map((group) => [...group])
	});
	if (typeof anyCtx.on === "function") anyCtx.on("loader/volatile-update", () => {
		const next = readConfigShape();
		const canonicalNext = canonicalShape(next);
		if (canonicalNext === lastMirror || !pushed) return;
		lastMirror = canonicalNext;
		writeChain = writeChain.then(async () => {
			try {
				const shape = fromSettingsShape(next);
				if (shape.groups.length === 0 && store.current.groups.length > 0) {
					warn(`refused to empty workspace-alias.json: the settings document has 0 group(s) while the file has ${store.current.groups.length} — edit the JSON file directly to clear the table on purpose`);
					const truth = toSettingsShape(store.current);
					lastMirror = canonicalShape(truth);
					await pushToConfig(truth).catch((error) => {
						warn(`settings document repair failed: ${String(error)}`);
					});
					return;
				}
				await saveAliasConfig(aliasConfigPath(), shape);
				await store.reload();
				for (const message of store.drainDiagnostics()) warn(message);
			} catch (error) {
				warn(`settings edit NOT written to workspace-alias.json: ${String(error)}`);
			}
		});
	});
	Promise.resolve().then(() => pushToConfig(toSettingsShape(store.current))).then(() => {
		pushed = true;
	}).catch((error) => {
		pushed = true;
		warn(`initial settings document write failed (settings UI shows stale values): ${String(error)}`);
	});
	store.onChange = () => {
		const shape = toSettingsShape(store.current);
		const canonicalNow = canonicalShape(shape);
		if (canonicalNow !== lastMirror) {
			lastMirror = canonicalNow;
			Promise.resolve().then(() => pushToConfig(shape)).catch((error) => {
				warn(`settings document update failed: ${String(error)}`);
			});
		}
		try {
			afterChange?.();
		} catch (error) {
			warn(`config-change hook failed: ${String(error)}`);
		}
	};
}
/**
* Wire the JSON <-> settings mirror. Called from `Service.init`; when the
* settings service is absent this resolves to a no-op.
*
* `afterChange` runs whenever the in-memory table really changed — a settings
* edit or an external (synced / hand-edited) JSON edit. The owner uses it to
* re-run work that depends on the table, so that switching a flag on (for
* example `adoptAliased`) takes effect without an app restart.
*/
function wireAliasSettingsBridge(ctx, store, afterChange) {
	const inject = ctx.inject?.bind(ctx);
	if (typeof inject !== "function") return;
	inject(["settings"], (settingsCtx) => {
		const settings = settingsCtx.settings;
		const logger = settingsCtx.logger;
		if (!settings?.register) return;
		let scope;
		try {
			scope = settings.register(ALIAS_SETTINGS_NAMESPACE, AliasSettingsSchema);
		} catch (error) {
			logger?.warn?.(`[dsh-workspace-alias] settings namespace registration failed — falling back to hand-edited JSON: ${String(error)}`);
			return;
		}
		let lastMirror = canonicalShape(toSettingsShape(store.current));
		let writeChain = Promise.resolve();
		let pushed = false;
		const warn = (message) => {
			logger?.warn?.(`[dsh-workspace-alias] ${message}`);
		};
		Promise.resolve().then(() => settings.replace(ALIAS_SETTINGS_NAMESPACE, toSettingsShape(store.current))).then(() => {
			pushed = true;
		}).catch((error) => {
			pushed = true;
			warn(`initial settings mirror failed (UI shows defaults until next sync): ${String(error)}`);
		});
		scope.watch?.((next) => {
			const canonicalNext = canonicalShape(next);
			if (canonicalNext === lastMirror) return;
			if (!pushed) return;
			lastMirror = canonicalNext;
			writeChain = writeChain.then(async () => {
				try {
					const shape = fromSettingsShape(next);
					if (shape.groups.length === 0 && store.current.groups.length > 0) {
						warn(`refused to empty workspace-alias.json: the settings mirror has 0 group(s) while the file has ${store.current.groups.length} — edit the JSON file directly to clear the table on purpose`);
						const truth = toSettingsShape(store.current);
						lastMirror = canonicalShape(truth);
						await settings.replace(ALIAS_SETTINGS_NAMESPACE, truth);
						return;
					}
					await saveAliasConfig(aliasConfigPath(), shape);
					await store.reload();
					for (const message of store.drainDiagnostics()) warn(message);
				} catch (error) {
					warn(`settings edit NOT written to workspace-alias.json: ${String(error)}`);
				}
			});
		});
		store.onChange = () => {
			const shape = toSettingsShape(store.current);
			const canonicalNow = canonicalShape(shape);
			if (canonicalNow !== lastMirror) {
				lastMirror = canonicalNow;
				Promise.resolve().then(() => settings.replace(ALIAS_SETTINGS_NAMESPACE, shape)).catch((error) => {
					warn(`settings mirror update failed: ${String(error)}`);
				});
			}
			try {
				afterChange?.();
			} catch (error) {
				warn(`config-change hook failed: ${String(error)}`);
			}
		};
	});
}
//#endregion
//#region src/index.ts
/**
* dsh-workspace-alias — cross-device workspace path aliasing for DeepSeek
* Harness.
*
* Replaces the official `@deepseek-ai/dsh-workspace` row (disabled via this
* package's cordis.patch.yml) with a subclass whose session-cwd
* canonicalization understands cross-device alias groups. Everything else
* (durable domain, entity lifecycle, service name `workspaceRegistry`) is
* inherited untouched, so `workspace-controller`, `ui-workspace` and the
* sidebar keep working without any change.
*
* What changes vs stock:
*  1. `indexHeader` resolves session header cwd through
*     `aliasAwareRealpath` — a foreign cwd (synced from another machine,
*     nonexistent locally) resolves to the local alias sibling, so synced
*     sessions group under the local workspace of the same project.
*  2. `Service.init` backfills cross-device sessions into the workspace record
*     that owns the resolved path. Eligible are sessions whose cwd resolved
*     through an alias this boot, sessions this boot's header migration just
*     rewrote from a foreign path, and — only with the `adoptAliased` opt-in —
*     unclaimed sessions whose canonical cwd is a declared alias member.
*     Locally-created sessions follow the stock attach flow, and deliberately
*     detached sessions have no claim and no foreign cwd, so the default pass
*     cannot resurrect a detach (see `backfillForeignSessions`).
*  3. Startup self-heal (`repairDuplicateClaims`): stock membership is
*     never pruned (the bootstrap merge retains sessionIds it does not
*     re-group), while `validateStoredState` hard-fails the whole plugin
*     tree when one session is claimed by two workspace records. Since
*     sessions sync across machines, such stale claims are a matter of
*     time; we repair deterministically before validation instead of
*     bricking: keep the claim whose workspace path matches the session's
*     alias-resolved cwd, tie-break by registry order. Backfill also strips
*     contradicting claims defensively before attaching.
*
* Config: `<dshHome>/workspace-alias.json` (see alias.ts) — editable either
* by hand or through the DSH settings page. settings.ts mirrors the file into
* whichever settings surface the host has (the entry's own volatile config on
* DSH >= 0.2.0-rc, the `workspace-alias` settings namespace before that); the
* file stays the synced true source. Put the file in your file-sync scope so
* every machine shares one table.
* @module dsh-workspace-alias
*/
const store = new AliasConfigStore();
/**
* Sessions whose cwd resolved through an alias (foreign cwd). Backfill uses
* this to attach exactly the cross-machine sessions — nothing else.
*/
const foreignResolved = /* @__PURE__ */ new Set();
/**
* Session ids whose stored header THIS boot's migration rewrote from a
* foreign path to a local one. Migration runs before `super.init()`, so by
* the time headers are indexed their cwd resolves locally and
* `aliasAwareRealpath` reports `aliased: false` — without this set those
* sessions would be indexed but never attached, which is exactly how synced
* Windows sessions landed in the rail's ungrouped section. Membership is
* deliberately not cleared by `aliasIndexHeader`: the rewrite, and with it
* the only evidence of foreign origin, happens before the first index pass.
*/
const migratedThisBoot = /* @__PURE__ */ new Set();
/**
* Alias-aware indexHeader. Same contract as the stock private method, with
* the cwd canonicalization swapped for `aliasAwareRealpath`. Assigned onto
* the subclass prototype below (the parent declares it `private`, which is a
* compile-time-only notion; runtime override is plain property assignment).
*/
async function aliasIndexHeader(header) {
	this.headers.set(header.id, header);
	this.sessionPaths.delete(header.id);
	foreignResolved.delete(header.id);
	if (header.cwd === void 0) {
		this.invalidSessionPaths.set(header.id, "header has no cwd");
		return;
	}
	let resolution;
	try {
		resolution = await aliasAwareRealpath(header.cwd, store.current, realpathNormalize);
	} catch {
		this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' does not resolve`);
		return;
	}
	try {
		if (!(await stat(resolution.path)).isDirectory()) {
			this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' is not a directory`);
			return;
		}
	} catch {
		this.invalidSessionPaths.set(header.id, `cwd '${header.cwd}' does not resolve`);
		return;
	}
	this.sessionPaths.set(header.id, resolution.path);
	this.invalidSessionPaths.delete(header.id);
	if (resolution.aliased) foreignResolved.add(header.id);
}
/**
* Strip session claims that contradict the session's alias-resolved cwd.
* The stock registry never prunes `sessionIds` (bootstrap merge keeps
* entries it does not re-group, and post-bootstrap there is no
* reconciliation), but `validateStoredState` hard-fails the entire plugin
* tree the moment one session is claimed by two records. Cross-machine
* session sync (plus stock attach flows that tolerate foreign membership)
* makes that state reachable, so instead of failing loud we repair:
*
* - the claim whose workspace `path` equals the session's alias-resolved
*   cwd survives (this is the attach canon of `indexHeader`);
* - when the header index is unavailable, or no record matches, the
*   earliest claim in the durable registry order survives.
*
* Runs right after `recoverPendingMutation` (base init) so the first
* `validateStoredState` sees a consistent table. Cheap when clean: one
* table scan, zero writes.
*
* Exported for the regression test that pins the header-index input shape —
* see `tests/repair.test.ts`.
*/
async function repairDuplicateClaims(self) {
	const state = self.requireState?.();
	const table = self.requireTable?.();
	if (!state || !table || table.size === 0) return;
	try {
		const headers = (await self.ctx.sessionPersistence.list()).map((row) => row && row.header !== void 0 ? row.header : row);
		const usable = headers.some((header) => header && typeof header.cwd === "string");
		await self.replaceHeaderIndex(usable ? headers : await self.listStoredHeaders());
	} catch {}
	const sessionPaths = self.sessionPaths;
	const orderOf = new Map(state.workspaceIds.map((id, index) => [id, index]));
	const records = new Map(table.entries());
	const betterClaim = (sessionId, left, right) => {
		const score = (id) => {
			const resolved = sessionPaths?.get(sessionId);
			return (resolved !== void 0 && records.get(id)?.path === resolved ? 1 : 0) * 2 - (orderOf.get(id) ?? Number.MAX_SAFE_INTEGER) / 1e9;
		};
		return score(left) >= score(right) ? left : right;
	};
	const winner = /* @__PURE__ */ new Map();
	for (const [id, record] of records) for (const sessionId of record.sessionIds) {
		const holder = winner.get(sessionId);
		winner.set(sessionId, holder === void 0 ? id : betterClaim(sessionId, holder, id));
	}
	let repaired = 0;
	for (const [id, record] of records) {
		const seen = /* @__PURE__ */ new Set();
		const kept = record.sessionIds.filter((sid) => {
			if (winner.get(sid) !== id) return false;
			if (seen.has(sid)) return false;
			seen.add(sid);
			return true;
		});
		if (kept.length === record.sessionIds.length) continue;
		const dropped = record.sessionIds.length - kept.length;
		await table.update(id, (current) => ({
			...current,
			sessionIds: kept,
			updatedAt: (/* @__PURE__ */ new Date()).toISOString()
		}));
		repaired += dropped;
		self.ctx.logger?.warn?.(`[dsh-workspace-alias] repaired workspace '${id}': stripped ${dropped} duplicate/stale session claim(s)`);
	}
	if (repaired > 0) self.ctx.logger?.warn?.(`[dsh-workspace-alias] repaired ${repaired} duplicate session claim(s): stock membership is never pruned, so cross-machine sync can leave a session claimed twice, which hard-fails validateStoredState`);
}
/**
* Base init calls `recoverPendingMutation()` immediately before the first
* `validateStoredState`, and the domain cannot be opened twice, so the
* repair hooks in there (prototype assignment — the base declares these
* members `private`, which is compile-time only).
*/
async function recoverPendingMutationWithRepair() {
	await WorkspaceRegistry.prototype.recoverPendingMutation.call(this);
	await repairDuplicateClaims(this);
}
/**
* The mountable replacement for `@deepseek-ai/dsh-workspace`. Same service
* name (`workspaceRegistry`), same durable domain, alias-aware session-cwd
* canonicalization.
*/
var AliasWorkspaceRegistry = class extends WorkspaceRegistry {
	static inject = ["storageDomain", "sessionPersistence"];
	/**
	* Settings document of this entry on DSH >= 0.2.0-rc. Declaring it is what
	* makes the host serve the `workspace-alias` namespace at all: pages are
	* built from `.volatile()` config fields (see src/settings.ts).
	*/
	static Config = AliasSettingsConfig;
	/** True once the stock registry state exists (set at the end of init). */
	ready = false;
	/** Live per-field config references handed in by the loader (or absent). */
	settingsRefs;
	constructor(ctx, config) {
		super(ctx);
		this.settingsRefs = config;
	}
	async [Service.init]() {
		await store.start();
		for (const message of store.drainDiagnostics()) this.ctx.logger?.warn?.(`[dsh-workspace-alias] ${message}`);
		store.onChange = () => this.onAliasConfigChanged();
		wireAliasSettingsBridge(this.ctx, store, () => this.onAliasConfigChanged());
		if (HOST_SETTINGS_ARE_CONFIG_BACKED) wireAliasConfigBridge(this.ctx, store, this.settingsRefs, () => this.onAliasConfigChanged());
		this.ctx.inject(["settings"], (child) => {
			try {
				child.effect(() => child.settings.configure({ auto: false }, this.ctx.fiber));
			} catch (error) {
				this.ctx.logger?.warn?.(`[dsh-workspace-alias] settings presentation not configured (host may render its own page): ${String(error)}`);
			}
		});
		const report = await migrateSessionHeaders({
			dshHome: dshHomePath(),
			config: store.current,
			log: (message) => this.ctx.logger?.info?.(`[dsh-workspace-alias] ${message}`)
		});
		if (report.unsupportedRuntime) this.ctx.logger?.warn?.("[dsh-workspace-alias] node:zlib zstd unavailable — header cwd migration skipped");
		for (const message of report.unresolvable) this.ctx.logger?.warn?.(`[dsh-workspace-alias] header cwd left as-is: ${message}`);
		for (const message of report.errors) this.ctx.logger?.warn?.(`[dsh-workspace-alias] header migration failed: ${message}`);
		for (const entry of report.rewritten) migratedThisBoot.add(entry.session);
		await super[Service.init]();
		this.ready = true;
		if (store.current.autoAttach) await this.backfillForeignSessions();
	}
	/**
	* React to a changed alias table. Only the boot-time init attaches
	* unconditionally; later changes re-run the same pass so a flag switched on
	* in the settings UI (or a table synced in from another machine) takes
	* effect immediately. A no-op before init and when autoAttach is off.
	*/
	onAliasConfigChanged() {
		if (!this.ready || !store.current.autoAttach) return;
		this.backfillForeignSessions().catch((error) => {
			this.ctx.logger?.warn?.(`[dsh-workspace-alias] attach pass after config change failed: ${String(error)}`);
		});
	}
	/**
	* Attach cross-device sessions to the workspace owning their alias-resolved
	* path. Three eligibility classes, all of them "this session cannot have a
	* local attach decision behind it":
	*
	* 1. resolved through an alias fallback this boot (its cwd did not exist
	*    locally, so it could never have been attached/detached here);
	* 2. rewritten by this boot's migration (same argument — the foreign cwd is
	*    what was on disk one moment ago);
	* 3. with the explicit `adoptAliased` opt-in, any unclaimed session whose
	*    canonical cwd is a declared alias-group member — the backlog case,
	*    which classes 1 and 2 cannot recognize because an earlier boot already
	*    consumed the foreign cwd. Off by default: `detachSession` leaves no
	*    tombstone, so adoption cannot distinguish a deliberate detach from a
	*    never-attached session.
	*
	* Runs on the registry write chain via the entity's own mutate (private is
	* compile-time only), so durability, updatedAt stamping, and membership
	* pruning are exactly the stock ones.
	*/
	async backfillForeignSessions() {
		const state = this.requireState?.();
		if (!state) return;
		const table = this.requireTable?.();
		if (!table) return;
		let attached = 0;
		let adopted = 0;
		const adoptAliased = store.current.adoptAliased === true;
		const declaredKeys = adoptAliased ? await aliasMemberKeys(store.current, realpathNormalize) : /* @__PURE__ */ new Set();
		for (const workspaceId of state.workspaceIds) {
			const entity = this.entities?.get(workspaceId);
			const record = table.get(workspaceId);
			if (!entity || !record) continue;
			for (const [sessionId, path] of this.sessionPaths) {
				if (path !== record.path) continue;
				if (record.sessionIds.includes(sessionId)) continue;
				const migrated = foreignResolved.has(sessionId) || migratedThisBoot.has(sessionId);
				if (!migrated) {
					if (!adoptAliased) continue;
					const headerCwd = this.headers?.get(sessionId)?.cwd;
					if (!(declaredKeys.has(pathKey(path)) || headerCwd !== void 0 && declaredKeys.has(pathKey(headerCwd)))) continue;
				}
				try {
					for (const [otherId, other] of table.entries()) {
						if (otherId === workspaceId || !other.sessionIds.includes(sessionId)) continue;
						await table.update(otherId, (current) => ({
							...current,
							sessionIds: current.sessionIds.filter((sid) => sid !== sessionId),
							updatedAt: (/* @__PURE__ */ new Date()).toISOString()
						}));
						this.ctx.logger?.warn?.(`[dsh-workspace-alias] stripped stale claim of session '${String(sessionId)}' from workspace '${String(otherId)}' (resolves to '${path}')`);
					}
					await entity.mutate((current) => current.sessionIds.includes(sessionId) ? current : {
						...current,
						sessionIds: [sessionId, ...current.sessionIds]
					});
					attached++;
					if (!migrated) adopted++;
				} catch (error) {
					this.ctx.logger?.warn?.(`[dsh-workspace-alias] backfill of session '${String(sessionId)}' failed: ${String(error)}`);
				}
			}
		}
		if (attached > 0) this.ctx.logger?.info?.(`[dsh-workspace-alias] attached ${attached} cross-device session(s) via alias`);
		if (adopted > 0) this.ctx.logger?.info?.(`[dsh-workspace-alias] adopted ${adopted} previously unclaimed session(s) whose cwd is a declared alias member (adoptAliased)`);
	}
};
AliasWorkspaceRegistry.prototype.indexHeader = aliasIndexHeader;
AliasWorkspaceRegistry.prototype.recoverPendingMutation = recoverPendingMutationWithRepair;
//#endregion
export { ALIAS_SETTINGS_NAMESPACE, AliasConfigStore, AliasSettingsConfig, AliasSettingsSchema, AliasWorkspaceRegistry, AliasWorkspaceRegistry as default, aliasConfigPath, dshHomePath, loadAliasConfig, migrateSessionHeaders, pathKey, projectKey, repairDuplicateClaims, wireAliasConfigBridge, wireAliasSettingsBridge, zstdFrameSize };
