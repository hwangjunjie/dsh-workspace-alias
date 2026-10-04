# 验证清单（官方桌面版 / macOS）

> 目标：确认 v0.4.4 在 **官方 DeepSeek Harness Desktop 0.2.0-rc.2** 上
> (a) 不再导致 client boot 失败、(b) 设置页可用且写回 `workspace-alias.json`、
> (c) 会话归组行为与 v3 时代一致。
> 源码侧单测已在本仓库执行：`npx tsc --noEmit` + `npx vitest run`（7 files / 62 tests）+ `npm run build`。

## 环境

- App：`/Applications/DeepSeek Harness.app`（asar 打包，0.2.0-rc.2）
- Profile：`desktop`（官方桌面版默认；目录 `~/.dsh/profiles/desktop`）
- CLI：`<app>/Contents/Resources/runtime/cli/bin/dsh`（headless 安装入口）

## 安装 / 升级

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop add https://github.com/hwangjunjie/dsh-workspace-alias
```

装完（或升级到 0.4.4）后核验安装副本：

```bash
P=~/.dsh/profiles/desktop/node_modules/dsh-workspace-alias
grep '"version"' "$P/package.json"                 # 期望 0.4.4
grep -c whileServed "$P/lib/client.js"             # 期望 > 0：新代际 configForms 分支
grep -n 'exports.inject' "$P/lib/client.js"        # 期望 ["slots"]，绝不能含 settingsScope
grep -n "bundles" -A20 ~/.dsh/profiles/desktop/package.json   # dsh.profile.bundles 含 dsh-workspace-alias
```

> 依赖解析说明：profile 的 `node_modules` 只放**profile 内**的包（pnpm hoisted 布局，
> 无 `.pnpm` 目录）。插件的 peerDependencies（`@deepseek-ai/cordis` /
> `@deepseek-ai/dsh-workspace` / `@deepseek-ai/schemastery`）由宿主提供——`dsh-app-boot`
> 的 `collectInstallationScopePackages()` 会遍历 app 自身 manifest 的依赖图，把
> installation scope 的包交给运行时解析器，因此**不需要**在 profile 里出现磁盘链接。

## 重启后验证

1. 重启 App。渲染端不应出现 `Renderer boot failed for 1 plugin(s)` /
   `RendererStartupFailure`（这是 0.4.3 及更早在 rc.2 上的症状：客户端静态注入了
   已被移除的 `settingsScope` 服务）。
2. **设置 → 插件 → 工作区别名**：应看到完整编辑区（别名组增删改 + `autoAttach` 开关），
   而不是「无法配置」/空白页。
   - 若宿主是 0.1.x：仍然走旧 namespace 桥，页面同样应出现。
3. 在页面上新增一组别名 → 保存 → 检查 `~/.dsh/workspace-alias.json` 已更新，
   且上一版被备份为 `workspace-alias.json.bak`。
4. 侧边栏 workspace 列表正常（说明替换后的 `workspaceRegistry` 生效）。
5. 打开本机 `notes` 项目对应的 workspace：来自另一台机器（cwd `/Volumes/Data/notes`）
   的会话应出现在该 workspace 的会话列表中。
6. 启动日志中查找 `[dsh-workspace-alias] attached N cross-device session(s) via alias`。
7. 空表保护：把设置页里的别名组全删掉再保存 → 插件应拒绝清空、告警，并回写为 JSON 中的真值
   （防止一次误操作把同步链路上的别名表清空）。

## 回归（会话格式）

- 磁盘上同时存在 `session.jsonl.zstd` / `session.v3.jsonl.zstd` / `session.v4.jsonl.zstd`；
  本插件用 `/^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/` 识别任意 N，且重写只替换首帧
  header 的 `cwd`（`{...header, cwd: target}` 展开保留 `version: 4` 等未知字段）。
- 与官方 `dsh-session-format` 的现行 `CANONICAL_LOG_FILENAME`
  `/^session(?:\.v([1-9][0-9]*))?\.jsonl$/u` 等价（上游只是额外禁止前导零）。

## 回退

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" plugin --profile desktop remove dsh-workspace-alias
```

重启后恢复官方 workspace 行为，数据无迁移、无损。

## 已知边界

- dsh 运行期间 Syncthing 新同步进来的会话，在**下次重启 dsh** 时归组
- 若 `workspace-alias.json` 写坏，插件保留上一份好配置并告警，不影响启动
- 插件需要 `@deepseek-ai/dsh-workspace` 内部形态稳定（rc 期风险；已在
  `dsh.compatibility.dshReleases` 声明 0.1.1-rc.1 ~ 0.2.0-rc.2）
