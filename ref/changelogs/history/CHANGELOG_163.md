# CHANGELOG_163 — UI 文案精简 + 通俗化(异构对抗 review)

## 概要

跨 30 个 renderer 文件做 UI 文案 review + 重写,把面向终端用户的设置项 / 弹窗 / 列表项里的 SDK / DB / IPC 内部术语全面去除,统一中英术语,补充弱化弹窗的兜底说明。走 `agent-deck:deep-review` SKILL 起 reviewer-claude (Claude Code, Opus) + reviewer-codex (Codex CLI, gpt-5.5) 异构对抗,Round 1 收口 30 条 finding,全部落地 + 全量 `pnpm typecheck` 0 error。

## 改动清单(按文件)

### 设置面板(`src/renderer/components/settings/sections/*`)

- **`AgentDeckMcpSection.tsx`**: 删除 helper text 内 15 个 mcp tool 全名密集 code 标签 + `owner_session_id` / `caller_session_id` / `mcpServers` / `==` / `sentinel` 等 DB / IPC 内部词,改为「开启后 AI 可在会话里调用工具管理其他会话和团队任务」+ 折叠详情 disclosure;3 个 NumberInput label 删 camelCase 字段名(`mcpMaxSpawnDepth` → 「最大调用深度」等);transport 表 `in-process` → 「应用内」、删 `Bearer token` 鉴权细节;权限模型简化为「任务由当前会话拥有,跨会话写需同属一个团队,外部客户端只能读取」
- **`ExperimentalSection.tsx`**: sandbox 档位 select option 中文化(`Workspace Write` → 「工作目录可写」、`Strict` → 「严格只读」、`Read Only` → 「完全只读」、`Danger Full Access` → 「⚠️ 完全开放」);删 `canUseTool` / `cwd` / `逃逸路径` 暴露;统一「⚠️ 仅对新建会话生效」生效边界提示
- **`WindowSection.tsx`**: 加可发现性提示「始终置顶 / 窗口透明 / 放大缩小窗口」三档快捷键说明,解决用户找不到对应开关问题

### 主对话框(`src/renderer/components/{SettingsDialog,AssetsLibraryDialog,NewSessionDialog,HandOffPreviewDialog}.tsx`)

- **`SettingsDialog.tsx`**: 「Codex CLI 专属配置」tab helper 删 `marker / build-time installer` / `mcp_servers.agent-deck` / `HTTP transport + Bearer token` / `codexSummaryModel` / `codexHandOffModel` 等开发者术语,改为「Codex 配置(模型/沙盒/审批/MCP 等)在 ~/.codex/config.toml 中编辑;应用安装时会把内置 Agent 配置同步进 ~/.codex/AGENTS.md 的 Agent Deck 区段,保留你写的其他内容」
- **`AssetsLibraryDialog.tsx`**: 删 `agent-deck plugin` / `Skills tab → Codex sub-tab` / `spawn` 等中英混说,「资产库」副标题 → `(Skills / Agents / 应用约定)`;CLAUDE.md / CODEX_AGENTS.md description 删 `marker 段` / `system prompt 末尾` 等技术词;codex agent 不支持 banner 改通俗
- **`NewSessionDialog.tsx`**: sandbox 档位 select 全面中文化(同 ExperimentalSection 同源);「工作目录 cwd」→「工作目录」;「首条消息」placeholder 「SDK 必须有首条消息才能启动 CLI 子进程」→「必填,启动会话需要第一条消息」;permission_mode 选项「Plan 模式(只规划不动手)」→「计划模式(只规划)」与 SandboxSelects 统一
- **`HandOffPreviewDialog.tsx`**: 删 `sonnet API` / `按 token 计费` 暴露 model 名 + 内部 prompt 长度细节;主说明从 4 行压缩为 2 行;按钮「起新会话接力 →」→「打开新会话接力」(去命令式箭头)

### 团队 / 会话面板(`src/renderer/components/{TeamHub,TeamDetail/*,SessionCard,SessionList,HistoryPanel}.tsx`)

- **中英术语统一**(新增 `lifecycleLabel` / `roleLabel` helper 集中处理):
  - `lead` → `负责人` / `teammate` → `协作者` / `member` → `成员`
  - `pending / delivering / delivered / failed / cancelled` → `待发送 / 发送中 / 已送达 / 失败 / 已取消`
  - `lifecycle` 字段值 `active / dormant / closed` → `进行中 / 已休眠 / 已结束`
  - `Spawn Lineage` 删冗余英文 → 「会话关系」
  - `Pending` 删冗余英文 → 「待处理」
  - `cross-adapter 消息` → 「消息」(删冗余技术词)
  - `member${count === 1 ? '' : 's'}` → `${count} 名成员` (删英文复数化逻辑)
  - relativeTime `just now / 3min ago` → 「刚刚 / 3 分钟前」
- **TeamDetail/index.tsx**: 关闭 / 归档弹窗删 `leftAt = now` / `events / messages / file_changes` / `archived_at` / `TeamHub` / `reactivate` 等内部词;按钮「关闭 N 个 teammate」→「关闭 N 个协作者」
- **TeamDetail/EventsSection.tsx**: `<unrenderable>` → 「(无法显示)」
- **TeamDetail/MessagesSection.tsx**: 删「↩ #abc12345...」截断 message id 给用户看 → 「↩ 回复」+ title「回复上一条消息」
- **TeamDetail/TasksSection.tsx**: 「present continuous form」/「priority N」开发者 hint → 「当前进度描述」/「优先级 N」
- **SessionCard.tsx**: 团队 hover title 删 `Agent Teams` / `[lead]` 英文标签,统一为「所在团队」/「负责人 / 协作者」
- **HistoryPanel.tsx**: 搜索 placeholder「关键字搜索 cwd / 标题 / 事件 / 总结…」→「搜索会话(目录 / 标题 / 事件 / 总结)…」;status 行 `已归档 (active)` → `已归档 (进行中)` 等翻译
- **SessionList.tsx**: 空 state 引导改通俗,「装」→「安装」、「跑 claude」→「运行 claude 命令」

### 会话详情 / Composer(`src/renderer/components/SessionDetail/*`)

- **ComposerSdk.tsx**: 3 个危险弹窗(完全免询问 / Codex 完全开放 / Claude 关闭沙盒)全面重写,删 `bypassPermissions` / `allowDangerouslySkipPermissions=true` / `sandbox=danger-full-access` / `SDK 子进程` / `5-10s busy` / `canUseTool` 内部 flag;统一为「需要重启当前会话。重启后 Claude / Codex ... 重启约需 5-10 秒。失败时会自动回到当前模式。继续?」用户向文案
- **composer-sdk/SandboxSelects.tsx**: 3 套档位 option 中文化(PERMISSION_MODE_OPTIONS / CODEX_SANDBOX_OPTIONS / CLAUDE_CODE_SANDBOX_OPTIONS),与 ExperimentalSection / NewSessionDialog 三处文案对齐 SSOT
- **composer-sdk/ErrorBanner.tsx**: 半角 `⚠` → 全角 `⚠️`;前缀分隔符 `：` → `:` 半角统一
- **SourceBadge.tsx**: 「内 / 外」单字徽章首次加 title「应用内创建的会话 / 外部终端启动的会话」
- **MessagesPanel.tsx**: 「本会话暂无跨会话消息(send_message)」删 mcp 函数名;reply chain title 「回复 message id: <hash>」→「回复上一条消息」
- **SessionDetail/index.tsx**: 3 条 cancel toast 文案模板化:`'Claude 自动取消了一条权限请求' / '提问' / '一次计划批准请求'` → 收敛为 `Claude 取消了一条<类型>` 模板
- **CliFooter.tsx**: 「请回到对应的终端窗口直接与 Claude 对话」→「请回到运行 claude 命令的终端窗口继续对话」(消解 Claude vs Claude Code CLI 歧义)

### Pending Rows(`src/renderer/components/pending-rows/*`)

- **AskRow.tsx**: 「已选 N/M」→「已回答 N/M 题」;「尚有题目未选,仍可提交(未选项保持空答)」→「未答题目将留空提交」;「Claude 主动取消了这次提问(流终止 / interrupt / 超时)」→「Claude 取消了这次提问」(删开发者细节)
- **ExitPlanRow.tsx**: 批准弹窗删 `bypass / 冷切` 内部词;targetMode label 与 SandboxSelects 统一;select title「批准后切到的权限模式(plan/acceptEdits/default 热切;bypass 冷切重启 SDK)」→「批准计划后切换到的权限模式(完全免询问需要重启会话)」
- **PermissionRow.tsx**: 「⚠ 等待授权」→「⚠️ 等待授权」(全角);「🚫 已被 SDK 取消」→「🚫 已取消」;「Claude 主动放弃了这次请求(流终止 / interrupt / 超时)」→「Claude 取消了这次请求」

### 资产库(`src/renderer/components/assets/*`)

- **AssetEditor.tsx**: 表单 label 改中文(`name / description / model / tools / body` → 「名称 / 说明 / 模型 / 工具 / 正文」);error message 删 `frontmatter / single-line / regex` 等术语;name 错误「必须匹配 /^[a-z0-9-]+$/」→「只能用小写字母、数字和短横线,首字符必须是字母或数字」;placeholder「这个 skill / agent 是干啥的」→「说明这个 Skill / Agent 的用途和触发场景」(改专业语气)
- **AssetCard.tsx**: 「model: / tools:」→「模型: / 工具:」
- **InjectionToggleBar.tsx**: 3 处「**下次新建会话**不再注入;已运行会话已固化注入列表」(markdown 字面量 + 内部术语暴露)→ 统一「⚠️ 仅对新建会话生效;已运行的会话不受影响」(并删 `**` markdown 标记)

### Activity Feed(`src/renderer/components/activity-feed/*`)

- **describe.ts**: 「⚪ 权限请求已被 SDK 取消」/「提问」/「计划批准请求」→ 删「SDK」内部词;「⚠」→「⚠️」全角;新增 `translateSessionEndReason` helper 把 SDK 英文枚举(`completed / aborted / error / max_turns / stop`)翻译为「正常结束 / 已中止 / 出错 / 达到对话上限 / 已停止」
- **rows/message-row.tsx**: hand-off disclosure summary 中英混 + lead `session_id` / `team_id` / `send_message` 内部术语暴露 → 改通俗「会话接力:负责人提供的上下文 / 接管的团队和协作者」;wirePrefix chip title 删 `(sid:Z) · msg M` 字段缩写,统一「来自 X(adapter)」
- **rows/thinking-row.tsx**: 「thinking」→「思考中」;「(空 thinking)」→「(暂无思考内容)」;「展开 (Nx字)」→「展开 (N 字)」(空格)
- **rows/tool-row.tsx**: 「exit N」→「退出码 N」;「(无输出 · status: X · exit N)」→「(无输出 · 状态: X · 退出码: N)」;「(plan 内容为空)」→「(计划内容为空)」

### 杂项(`src/renderer/components/{SummaryView,diff/DiffViewer}.tsx + settings/controls.tsx`)

- **SummaryView.tsx**: `formatTrigger` 「⏱ 周期 / 📊 事件 / ✋ 手动」→「⏱ 定时 / 📊 事件触发 / ✋ 手动」(动词化更明确)
- **diff/DiffViewer.tsx**: 「没有可用的 diff 渲染器(kind: <code>{payload.kind}</code>)」(把内部 kind 字段暴露给用户)→ 「无法显示此类型的差异」+ console.warn 给开发者
- **settings/controls.tsx**: 「已发送,没看到横幅请到 ...」→「已发送。若未看到横幅,前往 系统设置 → 通知 → ${name} 检查权限。」

### Helper 新增(`TeamDetail/helpers.ts`)

- 新增 `lifecycleLabel(lifecycle)`: 'active'→'进行中' / 'dormant'→'已休眠' / 'closed'→'已结束'
- 新增 `roleLabel(role)`: 'lead'→'负责人' / 'teammate'→'协作者'
- relativeTime 改中文输出(刚刚 / 秒前 / 分钟前 / 小时前 / 天前)
- statusBadge 改中文输出(待发送 / 发送中 / 已送达 / 失败 / 已取消)

## Review 流程

- 走 `agent-deck:deep-review` SKILL,kind='code',scope = `src/renderer/**/*.{tsx,ts}` 共 90 文件 12581 行
- Round 1 异构对抗:reviewer-claude (claude-code, Opus) + reviewer-codex (codex-cli, gpt-5.5),并发独立读取 + 各自 finding
- 共识 finding(双方独立提出): 8 大类(C1-C8),包括 AgentDeckMcpSection 内部术语 / Team 关闭弹窗 / 危险权限弹窗 / NewSessionDialog 沙盒术语 / HandOff 弹窗 model 暴露 / Team 中英混 / 资产库中英混 / AssetEditor schema 字段
- 单方独有 HIGH(claude 提): sandbox 跨 3 处不一 / 5 种生效边界措辞混 / lifecycle 直接打印 / kind 字段暴露 / send_message 函数名 / mcp__agent-deck__spawn_session 完整命名空间路径 / wire prefix 字段缩写
- 三态裁决:✅ 改 9 HIGH 类 + 8 MED + 12 LOW + 2 INFO,❓ 2 条由用户定夺(SummaryView formatTrigger + WindowSection 可发现性)→ 都改

## 验证

- `pnpm typecheck` 全量 0 error(每批 Edit 后增量检查 + 最终全量)
- 组件 props 类型契约保持不变(只改文案,不改 API)
- 未动 i18n 体系(项目目前无 i18n 字典,直接修改裸字符串字面量)
- 保留 ErrorBanner 内 stack trace 区域给开发者诊断的字段,只精简面向终端用户的标题

## 后续

- Round 2 / Round 3 视用户反馈再启动(本轮已基本覆盖 5 类 review focus 高密度问题)
- 中英术语统一后续如要追加新词,统一通过 `TeamDetail/helpers.ts` 新增 helper(避免散落各文件)
