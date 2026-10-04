# dsh-workspace-alias

[English placeholder — see 中文 README below for the full design doc.]

DeepSeek Harness plugin: cross-device workspace path aliasing. When your
`.dsh` session store is synced between machines (Syncthing etc.) but the same
project lives at different paths (`/Volumes/Data/notes` on macOS,
`F:\notes` on Windows), this plugin makes synced sessions group into the
local workspace of the same project instead of staying ungrouped.

Install (official desktop 0.2.0+): open **Settings → Plugins**, paste
`https://github.com/hwangjunjie/dsh-workspace-alias` into the install field
and confirm — the plugin manager runs the compatibility gate automatically.
Or use the official CLI:

```bash
dsh plugin --profile desktop add https://github.com/hwangjunjie/dsh-workspace-alias
```

(`dsh` ships with the desktop app at
`<app>/Contents/Resources/runtime/cli/bin/dsh`.)

Session format v4 (DSH 0.2.0-rc.1 / rc.2) is verified compatible: the
stored-header line structure is unchanged (only `version: 3 → 4`) and
generation files `session.vN.jsonl[.zstd]` are recognized for any N.

Configure `<dshHome>/workspace-alias.json`:

```json
{
  "version": 1,
  "groups": [["/Volumes/Data/notes", "F:\\notes"]]
}
```

---

# dsh-workspace-alias（中文说明）

## 解决什么问题

`.dsh` 的会话按「工作区绝对路径」分组：`/Volumes/Data/notes`（Mac）和 `F:\notes`（Windows）永远对不上。用 Syncthing 同步 `.dsh` 后，另一台机器同步来的会话因 cwd 在本机不存在而变成「未分组」。

本插件在 workspace registry 的 cwd 归一化层加一个跨机别名表：**外机 cwd → 本机同名项目的真实路径**，同步会话即可正确归桶。

## 安装

官方桌面版（0.2.0+）：**设置 → 插件**，在安装框粘贴仓库 URL
`https://github.com/hwangjunjie/dsh-workspace-alias`，确认安装后重启。
也可以用官方 CLI：

```bash
dsh plugin --profile desktop add https://github.com/hwangjunjie/dsh-workspace-alias
```

（`dsh` 随桌面版安装：`<app>/Contents/Resources/runtime/cli/bin/dsh`。）
安装时会自动过兼容门（peerDependencies 检查，本插件无需豁免）。

Session 格式 v4（DSH 0.2.0-rc.1 / rc.2）已验证兼容：存储头行结构未变（仅 `version: 3 → 4`），世代命名 `session.vN.jsonl[.zstd]` 对任意 N 均可识别，无需针对 V3 做额外适配。

插件自带的 `cordis.patch.yml` 会禁用官方 `workspace` 行并挂载本包（同服务名 `workspaceRegistry`），`workspace-controller` / `ui-workspace` / 侧边栏全部无感。

## 配置

两种方式，任选其一，结果等价（`workspace-alias.json` 始终是唯一真源）：

**方式一：DSH 设置界面（推荐，v0.4.0 起）**。双半区插件：host 侧向 settings 服务注册 `workspace-alias` namespace；client 侧（`lib/client.js`，DSH client-module 格式）注册 `settings.section` slot，设置页出现「工作区别名」完整编辑区（别名组增删改 + `autoAttach` 开关，草稿式编辑、原子保存），保存即写回 JSON 文件、热生效。宿主无 settings 服务时自动退化为方式二，无需任何配置。

**方式二：手工编辑** `<dshHome>/workspace-alias.json`（建议纳入你的 `.dsh` 同步白名单，一台维护、两端生效）：

```json
{
  "version": 1,
  "groups": [
    ["/Volumes/Data/notes", "F:\\notes"]
  ],
  "autoAttach": true
}
```

- `groups`：每个数组是一组「同一个项目在不同机器上的路径」，≥2 项
- `autoAttach`：启动时把「仅靠别名解析成功的会话」挂入本地 workspace（默认 true；这类会话不可能被本机主动 detach 过，不会违背手动整理意图）
- 修改后由文件 watcher 热加载；新同步进来的会话在**下次重启 dsh** 时归组

 remarks：
- 设置界面编辑同样写回 `workspace-alias.json`，因此 Syncthing 同步语义不变（一端 UI 修改，另一端 watcher 热加载）
- UI 写回前会把上一版内容备份为 `workspace-alias.json.bak`（防误清空）
- 单成员组合法但只能告警（它永远无法 alias 到另一台机器）；坏组跳过、不毒化整表（v0.2.4 容错语义）

## 原理（为什么不用 fork）

- 会话归属 = header 的 canonical cwd（`fs.realpath`）与 workspace path 字符串相等（官方 `paths.ts`："ONE uniqueness canon"）
- 归属校验只在两处读 cwd：`WorkspaceRegistry.indexHeader`（构建 sessionPaths 索引）与 `WorkspaceEntity.attachSession`
- 本包 `AliasWorkspaceRegistry extends WorkspaceRegistry`，只覆写 `indexHeader` 的 cwd 归一化：本机 realpath 失败 → 查别名组 → 用本机存在的兄弟路径 realpath
- 持久化 domain（`workspace` domain v2）与实体生命周期全部继承，零迁移

## 已知限制

- 需要 `@deepseek-ai/dsh-workspace` 的内部形态稳定（rc 期破坏性变更风险，已在 `dsh.compatibility` 声明 0.1.x）
- 只做「历史会话归组」；同步进行中的会话（dsh 运行时 Syncthing 写入）在下次重启时归组
- Windows 路径比较统一 `/` 分隔 + 大小写折叠（对 NTFS 不区分大小写的语义是正确的；对 macOS 大小写敏感盘的极端别名可能过宽）

## License

MIT
