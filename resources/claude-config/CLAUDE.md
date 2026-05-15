<!-- 由 resources/claude-config/CLAUDE.md 打包注入 SDK system prompt 末尾;维护说明详 resources/claude-config/README.md。 -->

--- Agent Deck 应用环境约定（随应用打包注入到每个 SDK 会话）---

# 应用环境约定

> 通用约定见 `~/.claude/CLAUDE.md`（CLI 按 user → project → app 顺序加载到 system prompt）。本文件只补 agent-deck 应用专属差异，不复制 user CLAUDE.md。
>
> **加载范围**：仅 `settingSources: ['user','project','local']` 的交互式 SDK 会话保证 user CLAUDE.md 加载。`settingSources: []` 的内部 oneshot（如间歇总结）**不**依赖 user CLAUDE.md 通用约定，需要时由调用方注入最小规则。

## 应用环境差异（Δ user CLAUDE.md）

### 协议覆盖：teammate 协作走 mcp tool

本应用环境（agent-deck）teammate 协作走 mcp tool（详 §Agent Deck Universal Team Backend 节）。teammate 通过 `send_message` 发消息 → universal-message-watcher → adapter.receiveTeammateMessage → adapter.sendMessage → SDK emit user-role event 自动注入 receiver conversation flow（receiver Claude 看到 user message 直接 act on it，无需主动 poll）。

### reviewer-codex 失败 → 应用环境额外有「合规兜底」分支

应用环境跑 `deep-code-review` SKILL 时若 reviewer-codex teammate 失败（CLI 不可用 / OAuth 过期 / Bash 卡审批被拒 / timeout），可走「合规兜底（仍异构）」：lead 自己 Bash `run_in_background: true` 起外部 codex CLI（按 reviewer-codex.md §codex CLI 调用模板填模板，lead 自己执行而非 wrapper teammate），与 reviewer-claude teammate 仍构成 gpt-5.5 vs Opus 4.7 异构对。

> 通用 CLAUDE.md `§reviewer-codex 失败兜底` 只走「严禁同源化降级 / 提示用户决策」一条；本应用环境额外有上述 SKILL 内合规兜底分支。详 SKILL.md `§失败兜底` 表第 1 行。

---

## Agent Deck Universal Team Backend

跨 adapter 协作通过 Agent Deck MCP 7 tool（`mcp__agent-deck__spawn_session` / `send_message` / `list_sessions` / `get_session` / `shutdown_session` / `archive_plan` / `hand_off_session`）编排。teammate 调工具时走自己 SDK 会话的 canUseTool，**lead 不插手 teammate 权限审批**（失败弹给真人走 teammate 自己 session 的 PendingTab）。

### 三个核心约定（lead 角度）

1. **spawn 首轮锚点**：`spawn_session` 返回 `spawnPromptMessageId: string | null`（仅当传 `team_name` 且 caller 在 sessions 表时非空），是首轮 prompt 在 messages 表的 placeholder id。teammate first turn 完成后调 `send_message({reply_to_message_id: spawnPromptMessageId, ...})` 回复，reply 自动注入 lead conversation。lead 不需主动 poll —— 看到 user-role wire-prefixed message 即知 reply 到了
2. **后续轮次锚点**：`send_message` 返回 `{ sessionId, teamId, messageId, replyToMessageId, sentAt, queued: true }`。caller 用 `messageId` 在 DB 查 reply chain（如有审计需求）；正常对话不需要 — receiver 收到 message 后会**自动通过 wire prefix `[msg <id>][sid <senderSid>]`** 提到 caller 的 messageId 当 `reply_to_message_id` 调 send_message reply 回来。`replyToMessageId` 仅当 caller 调 send 时显式传入 `reply_to_message_id` 才有值，开新话题（首条 message / 不挂 reply chain）时为 `null`
3. **shutdown 不删数据**：`shutdown_session` 只标 lifecycle='closed' + abort SDK live query；events / file_changes / summaries / messages 子表保留，lead 在裁决报告里仍可引用。`team_member` 通过 `left_at` 软退出（行不删，archive 时归档面板仍可看 member 历史）；`spawn_link` 父子关系全保留（list_sessions(spawned_by_filter) 跨 lifecycle 全见，跨会话救火依赖此）

> **dormant ≠ 丢 mental model**：lifecycle scheduler 转 dormant 只 abort SDK live query + 清 in-process Map，**不删 jsonl**；下一次 `send_message` 自动 SDK resume 复原对话历史。**唯一例外**：jsonl 缺失（用户手动删 `~/.claude/projects/` / 应用重装 / 跨设备同步未带）走 hard fail fallback → teammate 触发 `⚠ FRESH SESSION` warn 必须重 spawn。
>
> 实操：复用直接 `send_message`；彻底不再用才 `shutdown_session`。机制详 `src/main/adapters/claude-code/sdk-bridge/recoverer.ts:103-220`。

### send_message 一统消息发送

```ts
const result = await mcp__agent-deck__send_message({
  session_id: <target-sid>,           // target session id（receiver）
  team_id: <team-id>,                  // optional：caller / target 共享多 team 时必填，single-team 自动 resolve
  text: <message body>,
  reply_to_message_id: <messageId>,    // optional：链接 reply chain；从收到的 wire prefix `[msg <id>]` 提取
  caller_session_id: callerSid,
});
// result = { sessionId, teamId, messageId, replyToMessageId, sentAt, queued: true }
```

**发消息（普通 / reply）**：都用 `send_message`。reply 是普通 send_message 加 `reply_to_message_id` 字段（链接 DB 对话链）。

**收消息（自动注入 conversation flow）**：universal-message-watcher 异步把 message dispatch 给 receiver adapter → adapter.receiveTeammateMessage 把消息加 wire prefix `[from <senderName> @ <adapter>][msg <messageId>][sid <senderSessionId>]` → adapter.sendMessage 喂给 receiver SDK → receiver Claude 看到 user-role message 直接处理。

### 跨会话救火：list_sessions(spawned_by_filter)

lead context 重置 / 重启后捡 stranded reviewer：`list_sessions(spawned_by_filter:'<old_lead_sid>', status_filter:'active')` 拉自己以前 spawn 的 active reviewer；按 sessionId 调 `send_message` 发新 prompt（receiver reply 通过 wire prefix `[msg <id>][sid <senderSid>]` 自动挂 reply chain 注入 lead conversation，与 §三个核心约定 §2 后续轮次锚点同款）；收尾走 `shutdown_session`。

> ⚠️ **shared-team 前置约束**：`send_message` 必须在 caller session 与 target reviewer 至少共享一个 active team 时才能 dispatch（否则报 `no-shared-team` 立即 reject，不入 messages 表）。
> - **同 caller session（context 重置 / compaction）**：sessionId 不变 → team_member 关系不变 → 直接 `list_sessions(spawned_by_filter)` 捡回来 + `send_message` 即可
> - **真换了 caller session**（应用重启 / 用户手动新开 / hand_off_session 默认不携 team 起新 session）：新 caller 不在原 team 内 → `send_message` 必报 `no-shared-team` → 必须先满足以下任一条件：
>   1. 调 `spawn_session({adapter:'claude-code', team_name:<old-team-name>, ...})` 重起一对 reviewer（旧的走 `shutdown_session` 收尾，避免 ghost）
>   2. 通过 UI 手动把新 caller 加入旧 team（应用 → Team 面板 → Add Member）
>   3. `hand_off_session` 起新 session 时显式传 `team_name:<old-team-name>` 让新 session 直接落入 team（仅当 plan 接力同 team 场景；baton 单向交接默认场景不加 team）
> - 选项 1 简单粗暴但丢 reviewer 跨轮 mental model；选项 2/3 保留 mental model 推荐

### Wire format / regex / DB invariant

teammate 端协议约束（`[from <name> @ <adapter>][msg <id>][sid <senderSid>]\n` 三段 wire prefix / regex 提 messageId + senderSessionId / 用 send_message 回 / DB messages.body 不含 wire prefix 的 invariant）已强约束在 reviewer-{claude,codex}.md「核心纪律」节，**lead 不需关心**这些细节。Wire format 字段 schema 与字段语义 SSOT 在 `src/main/agent-deck-mcp/tools/schemas.ts`（应用 build 时把 description 注入 SDK system prompt 的 tool definitions）。

**wire format id invariant**：`messageId` / `senderSessionId` 都由 `crypto.randomUUID()` 生成（v4 UUID lowercase hex + hyphen，charset `[0-9a-f-]{36}`），regex `/\[msg ([0-9a-f-]+)\]\[sid ([0-9a-f-]+)\]/` 与该 charset 严格对齐。

### NO MSG ANCHOR 退化路径（reviewer 端 fallback）

reviewer agent 收到的 user message 顶部如果没找到 `[msg <id>][sid <senderSid>]` 双锚点 wire prefix（典型：lead context 重置后用裸文本 ping / 第三方 dispatch 路径丢前缀），按下面 fallback 处理：

1. reply 顶部硬性输出 `⚠ NO MSG ANCHOR — prompt 顶部没找到 [msg <id>][sid <senderSessionId>] wire prefix，本 reply 没法挂 reply_to_message_id 进 lead 对话链；建议 lead 通过 send_message 重新发本轮 prompt 提供 anchor`
2. **退化路径**：仍要交付 finding / codex 输出（不 abort）。`session_id` 反查：调 `mcp__agent-deck__list_sessions({adapter_filter: 'claude-code', status_filter: 'active'})` → 按以下顺序定位 lead：① displayName 含 "Lead-" 前缀 / ② displayName 非 reviewer-* 标识 / ③ team 内排除自己 sessionId 后唯一 active；3 条都失败走第 4 步终极兜底。`team_id` 反查：调 `list_sessions` 看自己 session 的 `teams[]` 字段（与 lead 共享的 team_id）
3. **副作用警告**：reply 不挂 `reply_to_message_id` 失去对话链锚点，DB / SessionDetail 看不出 reply 链关系；NO MSG ANCHOR 是**降级体验**，触发后 lead 应优先 shutdown + 重 spawn / 重发带 anchor 的 prompt 而非长期靠这个路径
4. **list_sessions 反查 lead 也失败**（多对 lead+teammate 同时跑歧义 / API 错）：直接把 finding / codex 输出落本 SDK session 的 assistant output（不调任何 mcp tool），lead 切到本 reviewer 的 SessionDetail UI 仍可看到

### plan hand-off 自动化：archive_plan

`archive_plan` 在 plan 完成后**原子执行** user CLAUDE §Step 4「完成」5 步：ff merge worktree branch → `base_branch` / 更新 frontmatter (`status=completed` + `final_commit` + `completed_at`) / mv plan → `<main-repo>/plans/<plan_id>.md` / 同步 `<main-repo>/plans/INDEX.md` / `git add` + commit / `git worktree remove` + `git branch -D`。caller 调用前必须先 `ExitWorktree(action: "keep")`。

**调用**：`mcp__agent-deck__archive_plan({ plan_id, worktree_path, base_branch?: "main", plan_file_path?, changelog_id?, keep_teammates?: false })`
**返回**：`{ archived_path, commit_hash, branch_deleted, worktree_removed, plans_index_action: 'created'|'appended'|'updated'|'unchanged', final_status, warnings: string[], archived: 'ok'|'failed'|'skipped', teammatesShutdown: { closed, failed, skipped } }`

**app-only 差异**：

- **预检短路**：plan status ≠ in_progress / worktree dirty / cwd 在 worktree 内 / detached HEAD 任一命中 → 立即返回 error，不做部分回滚（git 操作不可逆）
- **lead 必须先 ExitWorktree**：mcp 不能调 ExitWorktree CLI 内部 tool；cwd 在 worktree 内时 tool 直接 reject
- **自动归档 caller session**：plan 收口后默认归档 caller（baton 同款语义），返回 `archived` 三态字段；归档失败仅 warn 不阻塞 ok return
- **abandoned plan 不走本 tool**：tool 强制 `status=completed` 且入项目 git 归档；abandoned 走 user CLAUDE §Step 4 §中止 手工流程
- **changelog 引用归档** agent 自己写（tool 不做）
- **followup 20260515 (a)+(b)+(c)+(d) UX 完善**：
  - fallback 链 `<main-repo>/.claude/plans/` > `<main-repo>/plans/` > `~/.claude/plans/`(加中间档兜底本项目实际惯例)
  - `plan_file_path` 文件名 stem 必须 == `plan_id`(impl 层 reject 防 silent unlink)
  - INDEX 4 列 canonical `| 文件 | 状态 | 关联 changelog | 概要 |` + smart update existing 行(替换 status / changelog / description)
  - `changelog_id` optional string + csv(单值 `"122"` / 多值 `"121,122"`),拼成 markdown link 写入 INDEX 第 3 列;不传时 smart update 保留老 4 列 changelog 列 / 旧 2 列或新 append 用 `—` placeholder
  - `plans_index_action` 四态 enum 替代旧 boolean,让 caller 区分 INDEX 行真正发生的事情
  - `warnings` non-fatal warning 数组(如 `.claude/plans/<id>.md` 与 `plans/<id>.md` 同 id 双存覆盖警告 — 走 warn 而非 reject)
  - 7 phase post-ff-merge 失败专用 phaseHint 给具体 manual recovery 决策树(替代旧通用 hint)

### plan hand-off 自动化：hand_off_session

`hand_off_session` 起新 SDK session 接力 + 自动归档 caller。**双模式**：plan-driven 传 `plan_id`（读 plan frontmatter，要求 `status: in_progress` + 有 `worktree_path`，cold start prompt = `按 <plan-abs-path> 接力`，可附 `phase_label`）；generic 不传 `plan_id`（不读 plan，cold start prompt = `args.prompt` 或默认「从上一个会话接力继续工作」）。

**调用**：`mcp__agent-deck__hand_off_session({ plan_id?, phase_label?, prompt?, cwd?, adapter?: "claude-code", team_name?, permission_mode?, plan_file_path?, keep_teammates?: false })`
**返回**：`{ mode: 'plan'|'generic', planId, planFilePath, worktreePath, initialPrompt, sessionId, cwd, teamId, teamName, spawnPromptMessageId, archived, teammatesShutdown, ... }`

**app-only 差异**：

- **cwd resilience**：plan-driven 默认 `cwd = mainRepo`（fallback 链 `args.cwd > resolved.mainRepo > resolved.worktreePath`），让 sessionRepo.cwd 在 worktree 被 archive_plan 删后仍 valid；新 session 自己按 user CLAUDE §Step 3 cold-start `EnterWorktree(path: worktreePath)` 进 worktree。generic 默认 `cwd = caller cwd`
- **baton 不计 spawn_depth**：内部 spawn 传 `batonMode: true` 跳 depth check + 写 `parentDepth`（lateral，不 +1）。理由：baton 单向交接（spawn 后立即 archive caller）任意时刻只 1 个 active session，**不构成 fork-bomb 风险**，N-phase 接力链不该撞默认 `mcpMaxSpawnDepth=3`。fan-out + spawn-rate guard 仍 enforce
- **archive 无条件**：caller 无论 untracked / dirty / 已加入 team 都归档；不允许 caller 传字段「不归档我」 — baton 语义保证「任意时刻单 in-flight session」
- **default 不加 team**：baton 单向交接不强加 lead/teammate 关系；显式 `team_name` 才启用通信
- **预检短路**：plan-driven 模式 plan 文件不存在 / status ≠ in_progress / frontmatter 缺 `worktree_path` / spawn 失败 → 立即返回 error
- **新 session 必须含 user CLAUDE「复杂 plan」节**（`settingSources: ['user', ...]` 自动满足），否则 plan-driven cold start prompt 不被识别
- **典型主动触发（generic mode）**：当前 cwd 不适合手头任务（cwd 已失效 / 不属目标 repo / 用户明示换目录 / 跨 repo 任务）→ 不要在当前 session 强行 `cd` / 跨目录绝对路径，用 generic mode 显式传新 `cwd` + 自包含 `prompt` 接力到正确目录
- **prompt 装不下完整 context 时**（必要信息务必传递完整，避免 hand-off 丢失大量上下文）：caller 先把 context 落盘到 `/tmp/handoff-<id>.md`（临时文件不用清理），prompt 起手写「先 `Bash: cat <abs-path>` 再按文件内指令推进」让新 session cold-start 第一步读全
- **想保留 caller 不归档** → 用 `spawn_session(cwd:<目标>, prompt:<打包信息>)` 而非 `hand_off_session`（baton 强归档不可关）

### recoverer cwd 启发式 fallback（兜底）

caller 取消归档继续给已收口 plan-driven session 发消息（撞 cwd 失效）/ 用户手动 `git worktree remove` 不走 archive_plan / 跨设备同步丢目录 → sdk-bridge.recoverer 启发式找仍存在的祖先目录当 cwd 兜底（worktree 路径取段之前部分 / 父目录 walk 不超过 home），找到 → emit info + 强制走 jsonl missing fallback 同款下游（CLI 历史失但应用层 events / file_changes / summaries 子表保留）；找不到 → emit error 清晰告诉用户。算法详 `src/main/adapters/claude-code/sdk-bridge/recoverer.ts:103-220`。
