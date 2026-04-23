# CHANGELOG_5: README 三轮同步（含 466→264 重构）

## 概要

合并原 CHANGELOG_8（首次同步：首条消息必填 / settings env / DB v4 / 测试通知按钮）+ CHANGELOG_12（二次同步：Permission/AskRow 内嵌、resume、SDK vs Hook session-end 差异）+ CHANGELOG_45（README 重构 466→264 行）。三轮文档跟齐与最终重构。纯文档变化，无代码改动。

## 变更内容

### 第一轮同步（原 CHANGELOG_8）

- **应用内新建会话**：首条消息标注「必填」并解释（SDK streaming 要求 stdin 首条 user message 才会启动 CLI 子进程）；模型选项首项从「默认（跟随 SDK）」改为「按本地 settings.json」；权限模式补一句「用户上次选过的会持久化在 `sessions.permission_mode`」
- **Claude Code SDK 通道**：新增说明 `applyClaudeSettingsEnv()` 的作用（注入 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / 模型映射），bootstrap 时把 `~/.claude/settings.json` 的 env 字段灌入 process.env，关键防 Invalid API key
- **持久化 SQLite**：迁移系统从一行扩成结构化列表，补全 v1-v4 含义；明确 `db.ts` 内联 SQL，按 `user_version` pragma 增量推进
- **设置面板「提醒」**：补「测试系统通知」按钮（dev 模式下要在 系统设置 → 通知 → Electron 里允许）
- **项目结构图**：`claude-code/` 子目录加 `settings-env.ts`；`store/` 加 `migrations/v001_init.sql`（标注「实际逻辑在 db.ts 内联」）
- 同时去掉 README 里散着的「我本机」具体路径（`~/Repository/personal/agent-deck/`、`/tmp` 示例 cwd），改为占位符或跨平台标准位置说明

### 第二轮同步（原 CHANGELOG_12）

- **半透明毛玻璃**：CSS 描述同步 `saturate(220%) brightness(0.92)`（CHANGELOG_3 改的没回 README）+ 默认底色 `rgba(12,14,20,0.78)` + pin 模式数值 `rgba(18,18,24,0.2) + blur(18px)`
- **会话生命周期**：session-end 在 SDK 与 Hook 通道处理不同 —— SDK → dormant（jsonl 还在，可 resume），Hook → closed（终端 CLI 真退出）。原文写的一刀切「session-end → closed」与 `SessionManager.ingest()` 实际行为不符
- **新增「会话恢复（resume）」节**：介绍 SessionDetail 底部输入框捕获 `not found` 时弹「会话已断开 / 恢复会话」按钮 + `createAdapterSession({...resume})` 加载历史 jsonl
- **Claude Code SDK 通道**：补 30s fallback / tempKey 重命名说明、cwd 待领取标记（`expectSdkSession`）说明
- **工具权限请求节重写**：顶部 banner **已废弃**，改活动流内嵌 `PermissionRow`；Edit/Write/MultiEdit 的 toolInput 翻译成 Monaco DiffViewer 直接画在行内；已响应行变「⚪ 已处理」灰带；Claude 自动取消 pending 时弹 5s toast
- **Claude 主动询问节重写**：banner 同样废弃，改活动流内嵌 `AskRow`；取消「单选立即提交」逻辑（CHANGELOG_3）
- **SessionDetail 节重写**：顶部 banner → 顶部 toast；活动 Tab 行渲染按 event kind 拆开列举（MessageBubble / PermissionRow / AskRow / ToolStartRow / ToolEndRow / SimpleRow）；改动 Tab 补按文件分组按钮带改动次数小角标
- **项目结构补**：cwd 待领取标记 + `renameSdkSession` / summarizer prompt 标注 / `sound.ts` 防叠播 / `permissionMode → setPermissionMode/rename` / `REMOVED_KEYS` / App.tsx mount 时 `listAdapterPendingAll` / FloatingFrame pin 两套样式 / SessionDetail 自动取消 toast / `setPendingRequests/setPendingRequestsAll` / `onSessionRemoved/onSessionRenamed` / globals.css 默认底色加深

### 第三轮重构（原 CHANGELOG_45）

- **466 行 → 264 行（-43%）**
- 一级章节：11 → 8（顶部介绍、截图、主要能力、核心概念、安装与使用、命令行接入、设置、项目结构、开发指南、进一步阅读）
- 三级章节：30+ → 14
- 「主要能力」重写成 8 个一句话 bullet
- 「权限请求」「AskUserQuestion」「ExitPlanMode」三个独立大节合并成主要能力一行 bullet + Adapter capabilities 表说差异
- 「Claude Code SDK 通道」「Hook 通道」「Codex CLI SDK 通道」三大节合并到核心概念下「会话来源：内 vs 外」
- 「项目结构」97 行 → 32 行：只列二级目录 + 关键文件 + 一行职责
- 「打包必须知道的几件事」列 5 条核心坑 + 对应 CHANGELOG 编号，详细原因不复述
- 安装步骤从「开发与运行」末尾提到「安装与使用」靠前位置
- 删除「毛玻璃 CSS 陷阱」「pin 残影 invalidate」「30s fallback / tempKey rename」「cwd 待领取标记」「会话恢复 resume 实现细节」等纯实现陷阱节（这些是开发者读 changelog 的事）
- 截图占位保留 `<!-- TODO: 补一张主界面截图 -->`，不凭空贴图

## 备注

- 取舍：删的全是「为什么这么设计」「实现细节陷阱」类内部信息（这些本来就该在 changelog / 代码注释，不该在 README）；功能能力 0 删除（只是合并描述）
- 一些读者可能找的内容（毛玻璃 CSS 数值、pin invalidate 频率、Codex 单工 turn 队列实现）现在只在 changelog 里 —— 这是有意取舍，README 不该是「让 maintainer 也舒服」的全能文档
