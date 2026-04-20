# CHANGELOG_8: README 与代码现状同步

## 概要

完整通读项目后回填 README.md 漏掉 / 滞后的描述。没动代码，只改文档。修补的几处都是历史变更（CHANGELOG_3/6 + 后续小改）已经合入主干但 README 没同步：

- 新建会话弹窗：首条消息已经是必填（SDK streaming 协议要求），README 还写的是「可选」
- SDK env 注入：`applyClaudeSettingsEnv()` 在 bootstrap 时把 `~/.claude/settings.json` 的 `env` 字段（代理 / Bearer token）灌入主进程 `process.env`，这步关键防 Invalid API key，但 README 完全没提
- DB 多了 v4 migration（`sessions.permission_mode` 持久化用户上次选过的权限模式），README 还停留在「v1 / v2 / v3」
- 设置面板「提醒」section 多了「测试系统通知」按钮（`NotificationTestRow`），README 没写
- 项目结构图没列 `settings-env.ts` 与 `migrations/` 子目录

## 变更内容

### README.md

- **应用内新建会话（＋ 按钮）**：
  - 首条消息标注「必填」并解释原因（SDK streaming 要求 stdin 首条 user message 才会启动 CLI 子进程）
  - 模型选项首项从「默认（跟随 SDK）」改为「按本地 settings.json」（与 `MODEL_OPTIONS[0].label` 对齐）
  - 权限模式补一句「用户上次选过的会持久化在 `sessions.permission_mode`，下次切回 detail 自动还原」
- **Claude Code SDK 通道**：新增一条说明 `applyClaudeSettingsEnv()` 的作用（注入 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / 模型映射）
- **持久化（SQLite）**：把迁移系统从一行扩成结构化列表，补全 v1–v4 含义；明确「`db.ts` 内联 SQL，按 `user_version` pragma 增量推进」
- **设置面板（⚙）「提醒」一行**：补「测试系统通知」按钮（含 dev 模式下要在 系统设置 → 通知 → Electron 里允许的提醒）
- **项目结构图**：
  - `claude-code/` 子目录加 `settings-env.ts`
  - `store/` 子目录加 `migrations/v001_init.sql`（标注「实际逻辑在 db.ts 内联」，避免读者误以为它是真的迁移源）
  - `db.ts` 描述加「v1–v4 内联 SQL，按 user_version 推进」
  - `session-repo.ts` 描述加 `permissionMode`
- **鉴权与本地配置复用**：原 3 条扩为 4 条，新增 `applyClaudeSettingsEnv` 的完整说明（也回应了 README 主体「SDK 通道」一节）

### changelog/INDEX.md

- 追加 CHANGELOG_8 条目

## 备注

- 这次没改代码，所以不需要跑 typecheck / build
- 后续如果再发现 README 与现状脱节，可以并入这条（小改动），或者发现新功能再新建条目（大改动）

---

## 追加：去掉 README 中的本机私有路径

发现 README 里散着几处「我本机」的具体路径，对其他读者无意义且会误导。统一替换：

- 顶部「项目位于 `~/Repository/personal/agent-deck/`」一行直接删除（README 在仓库内，clone 后自然知道位置）
- 「持久化」一节的 `~/Library/Application Support/agent-deck/agent-deck.db` 改为「应用 userData 目录下的 `agent-deck.db`」并在括号里同时给出 macOS / Windows / Linux 的标准位置
- 「首次准备」代码块去掉 `cd ~/Repository/personal/agent-deck`
- 「验证 Hook 通道」curl 示例里的 `cwd: "/tmp"` 改为占位符 `<任意目录>`
- 「查 SQLite」从硬编码 `sqlite3 "$HOME/Library/..."` 命令改为「打开应用 userData 目录下的 `agent-deck.db`」+ 纯 SQL 片段，让命令对所有平台通用

保留的标准路径（不属于「本机私有」）：
- `~/.claude` / `~/.claude/settings.json` / `~/.claude/.credentials.json`：Claude Code 产品标准位置，必须写明
- `~/.config/agent-deck/` / `%APPDATA%/agent-deck/`：跨平台 userData 标准约定

