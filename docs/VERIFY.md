# 验证清单（Windows 端执行）

> M1 代码已在 Mac 端完成单测（10/10）+ tsc + 构建；端到端验证需要一台
> 正常运行的 dsh 环境。Mac 当前未安装 dsh，故留此清单。

## 前置

- Windows 端 dsh 正常运行，`.dsh` 已通过 Syncthing 同步（含 `sessions/`）
- `C:\Users\<你>\.dsh\workspace-alias.json` 已创建（或在 Mac 创建后同步过来）：

```json
{
  "version": 1,
  "groups": [["/Volumes/Data/notes", "F:\\notes"]]
}
```

## 安装

```powershell
dsh plugin --profile web add D:\path\to\dsh-workspace-alias
# （发布后可改用 npm 包名或 GitHub 地址）
```

> 部署备注（2026-09-09）：
> - `~/.dsh/plugin-dist/` 即 DSH 本地插件的规范安装位置——`~/.dsh/profiles/web/package.json`
>   以 `link:../../plugin-dist/<name>` 引用，且 `~/.dsh/sync-ignore.txt` 白名单
>   `!/plugin-dist/**` 承担跨机（Syncthing）分发。
> - 日常开发在源码 repo 构建 + 部署：`npm run release`（= build + deploy），
>   deploy 脚本（`scripts/deploy.mjs`）同步 lib/、package.json、cordis.patch.yml、
>   README、NOTICE 到 plugin-dist，避免手工 cp 漏文件（0.2.2 → 0.2.3 曾因只 cp
>   index.js 导致 plugin-dist 的 package.json 停留在旧版本）。
> - repo 已恢复 git 管理并发布于 GitHub（2026-09-09）：
>   https://github.com/lodfather/dsh-workspace-alias

确认 `profiles/web/node_modules/dsh-workspace-alias/lib/index.js` 存在。

## 验证步骤

1. 重启 `dsh web`，启动日志中不应有 workspace 相关报错
2. Web UI 侧边栏 workspace 列表正常显示（说明替换后的 registry 工作正常）
3. 打开 `F:\notes` workspace：来自 Mac 的会话（cwd 为 `/Volumes/Data/notes`）应出现在该 workspace 的会话列表中
4. 启动日志中查找 `[dsh-workspace-alias] attached N cross-device session(s) via alias`
5. 在本地新建一个会话，确认正常归组、正常工作（回归验证）
6. 修改 `workspace-alias.json`（如改 autoAttach），确认无需重启即被读取（watcher）；重启后生效归组

## 回退

```powershell
dsh plugin --profile web remove dsh-workspace-alias
# 重启后恢复官方 workspace 行为，数据无迁移、无损
```

## 已知边界

- dsh 运行期间 Syncthing 新同步进来的会话，在**下次重启 dsh** 时归组（M2 可加会话事件监听）
- 若 alias 表 JSON 写坏，插件保留上一份好配置并告警，不影响启动
- npm 上 `@deepseek-ai/dsh-workspace@latest` 指向旧版 0.0.1-rc.1（依赖缺失装不上），
  运行时解析的是宿主 dsh bundle 内的同名包（0.1.2-rc.1），与源码核对版本一致
