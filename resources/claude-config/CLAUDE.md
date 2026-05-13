<!--
此文件由仓库 `resources/claude-config/CLAUDE.md` 打包注入到每个 SDK 会话的 system prompt 末尾。
不要手动改打包后版本；改 `resources/claude-config/CLAUDE.md` + 应用 build。
本文件**只放 agent-deck 应用专属差异**；通用约定全部由 `~/.claude/CLAUDE.md` 提供（CLI 已按 user → project → 这份顺序加载，user 内容已先入 system prompt，不再复制）。
维护说明详 `resources/claude-config/README.md`。
-->

--- Agent Deck 应用环境约定（随应用打包注入到每个 SDK 会话）---

# 应用环境约定

> **通用约定**（输出 / 运行时 / 决策对抗 / 复杂 plan / 工程地基 / 模板）见 `~/.claude/CLAUDE.md` —— CLI 加载顺序（user → project → app）保证已先入本会话 system prompt。本文件只补 agent-deck 应用专属差异，不再复制 user CLAUDE.md 任何内容。
>
> **保证范围**：仅对 `settingSources: ['user','project','local']` 的交互式应用 SDK 会话保证 user CLAUDE.md 已加载（如应用内 ComposerSdk 起的会话）。`settingSources: []` 的内部 oneshot（如间歇总结 SDK 调用）**不**依赖 user CLAUDE.md 通用约定，需要时由调用方自行注入最小规则。

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

> **dormant ≠ 丢 mental model**（关键反直觉，**别再推理错**）：lifecycle scheduler 把 idle session 自动转 `dormant` 只是 abort SDK live query + 清 in-process Map，**不删 jsonl 文件**。下一次 `send_message` 给 dormant session：universal-message-watcher → adapter.sendMessage → sdk-bridge 检测 `!sessions.has(sid)` → recoverAndSend 预检 jsonl 在 → `createSession({resume: oldSid, prompt})` → CLI 复原对话历史 → teammate 看到自己上轮 reply + 已读文件痕迹 → in-memory mental model 通过 conversation history 隐式保留 ✅。**只有 jsonl 缺失**（典型：用户手动删 ~/.claude/projects 目录 / 应用重装 / 跨设备同步未带 jsonl）走 hard fail fallback (createSession 不带 resume) 才真 fresh = teammate 触发 `⚠ FRESH SESSION` warn = 必须重 spawn。所以「dormant 后想复用 mental model 不必担心，直接 send_message 就好」；只有彻底不再用才 `shutdown_session`。具体机制详 `src/main/adapters/claude-code/sdk-bridge/recoverer.ts:103-220` 与 user CLAUDE.md「会话恢复 / 断连 UX」节。

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

**收消息（自动注入 conversation flow）**：universal-message-watcher 异步把 message dispatch 给 receiver adapter → adapter.receiveTeammateMessage 把消息加 wire prefix `[from <senderName> @ <adapter>][msg <messageId>][sid <senderSessionId>]` → adapter.sendMessage 喂给 receiver SDK → receiver Claude 看到 user-role message 直接处理。**lead/teammate 都无需主动 poll**。

### 跨会话救火：list_sessions(spawned_by_filter)

lead context 重置 / 重启后捡 stranded reviewer：`list_sessions(spawned_by_filter:'<old_lead_sid>', status_filter:'active')` 拉自己以前 spawn 的 active reviewer；按 sessionId 调 `send_message` 发新 prompt。reply 自动注入新 lead conversation flow（与 spawn 后第一轮同款），新 lead 不需主动 poll；收尾走 `shutdown_session`。

> ⚠️ **shared-team 前置约束**：`send_message` 必须在 caller session 与 target reviewer 至少共享一个 active team 时才能 dispatch（否则报 `no-shared-team` 立即 reject，不入 messages 表）。
> - **同 caller session（context 重置 / compaction）**：sessionId 不变 → team_member 关系不变 → 直接 `list_sessions(spawned_by_filter)` 捡回来 + `send_message` 即可
> - **真换了 caller session**（应用重启 / 用户手动新开 / hand_off_session 默认不携 team 起新 session）：新 caller 不在原 team 内 → `send_message` 必报 `no-shared-team` → 必须先满足以下任一条件：
>   1. 调 `spawn_session({adapter:'claude-code', team_name:<old-team-name>, ...})` 重起一对 reviewer（旧的走 `shutdown_session` 收尾，避免 ghost）
>   2. 通过 UI 手动把新 caller 加入旧 team（应用 → Team 面板 → Add Member）
>   3. `hand_off_session` 起新 session 时显式传 `team_name:<old-team-name>` 让新 session 直接落入 team（仅当 plan 接力同 team 场景；baton 单向交接默认场景不加 team）
> - 选项 1 简单粗暴但丢 reviewer 跨轮 mental model；选项 2/3 保留 mental model 推荐

### Wire format / regex / DB invariant

teammate 端协议约束（`[from <name> @ <adapter>][msg <id>][sid <senderSid>]\n` 三段 wire prefix / regex 提 messageId + senderSessionId / 用 send_message 回 / DB messages.body 不含 wire prefix 的 invariant）已强约束在 reviewer-{claude,codex}.md「核心纪律」节，**lead 不需关心**这些细节。Wire format 字段 schema 与字段语义 SSOT 在 `src/main/agent-deck-mcp/tools/schemas.ts`（应用 build 时把 description 注入 SDK system prompt 的 tool definitions）；`docs/agent-deck-mcp-protocol.md` 已降级为 stub，仅保留指针不再维护完整规范。

### plan hand-off 自动化：archive_plan

完成 `~/.claude/CLAUDE.md` 的「复杂 plan：worktree 隔离 + 跨会话 hand off」流程的 §Step 4 cleanup 一次调用代替 5 步 Bash：

```ts
const result = await mcp__agent-deck__archive_plan({
  plan_id: '<plan-id>',                      // 与 worktree 目录名 / plan 文件 stem 一致
  worktree_path: '<absolute-worktree-path>', // /Users/.../repo/.claude/worktrees/<plan-id>
  base_branch: 'main',                       // 默认 'main'
  // plan_file_path: '<override>'            // 默认按 <main-repo>/.claude/plans/<id>.md → ~/.claude/plans/<id>.md fallback
});
// result = { archived_path, commit_hash, branch_deleted, worktree_removed, plans_index_appended, final_status: 'completed' }
// 默认行为：plan 收口后自动归档 caller session（baton 同款语义；archived: 'ok' | 'failed' | 'skipped' 字段）
```

tool 自动完成：git ff merge worktree branch → base_branch / 更新 plan frontmatter (status=completed + final_commit + completed_at) / mv plan 到 `<main-repo>/plans/<plan-id>.md` + 同步 `plans/INDEX.md` / git add + commit / git worktree remove + branch -D / 自动归档 caller session。

任一预检失败（worktree dirty / cwd 在 worktree 内 / plan status ≠ completed / detached HEAD）立即返回 error 短路。**lead agent 必须先 ExitWorktree** 让 cwd 出 worktree 再调本 tool（mcp 不能调 ExitWorktree CLI 内部 tool；cwd 在 worktree 内时 tool 直接 reject 提示 ExitWorktree）。

### plan hand-off 自动化：hand_off_session

完成 `~/.claude/CLAUDE.md` 的「复杂 plan：worktree 隔离 + 跨会话 hand off」流程的 §Step 3 接力姿势 §选项 B（自动起新 SDK session 接力下一 phase，免去用户手动新开会话 + 复制 cold start prompt）；同时双模式还支持任意会话不带 plan 也能 baton 交给新 session。

**plan-driven 模式**（传 `plan_id`）：

```ts
const result = await mcp__agent-deck__hand_off_session({
  plan_id: '<plan-id>',                      // 传 plan_id 走 plan-driven 模式
  phase_label: 'H3 Phase 4b',                // 可选，附加到 cold start prompt 后缀「（Phase: <label>）」
  // 其他字段 cwd / adapter / team_name / permission_mode / plan_file_path 默认即可
  // team_name 默认不传（baton 单向交接不强加 lead/teammate 关系）
});
// result = {
//   mode: 'plan',
//   planId, planFilePath, worktreePath, baseBranch, phaseLabel, initialPrompt,
//   ignoredFields: [],  // plan 模式始终空
//   sessionId, adapter, cwd, teamId (默认 null), teamName (默认 null),
//   spawnDepth, sentAt, spawnPromptMessageId (默认 null),
//   archived: 'ok' | 'failed' | 'skipped'
// }
```

tool 自动跑：解析 plan 文件路径（caller cwd 反查 main-repo → `<main-repo>/.claude/plans/<plan-id>.md` / fallback `~/.claude/plans/<plan-id>.md`） / 读 plan frontmatter 拿 `worktree_path` + `base_branch` / 校验 status === `in_progress` / 构造 cold start prompt = `按 <plan-abs-path> 接力`（含 phase_label 时附 `（Phase: <label>）` 后缀） / 调 `spawn_session` 起新 SDK session（**cwd resilience**：cwd default = mainRepo 而非 worktreePath，让新 session sessionRepo.cwd 在 worktree 被 archive_plan 删后仍 valid；新 session 按 user CLAUDE.md §Step 3 cold-start 自己 EnterWorktree(path: worktreePath) 进 worktree 干活；fallback 链 `caller args.cwd > resolved.mainRepo > resolved.worktreePath`） / **baton 语义**：default 不加任何 team（caller 不被打 lead 标签 / 新 session 不被打 teammate 标签；显式传 `team_name` 才启用通信关系）+ default 自动归档 caller session（baton 完整交出原会话退出，归档失败仅 warn 不阻塞 ok return）。

**generic 模式**（不传 `plan_id`）：

```ts
const result = await mcp__agent-deck__hand_off_session({
  // 不传 plan_id → 走 generic 模式
  prompt: '继续 review #42 的反馈,重点看 race condition',  // 可选,默认 '从上一个会话接力继续工作'
  // cwd 默认 = caller session cwd (从 sessionRepo 反查) ↓ resolved.mainRepo (兜底)
});
// result = {
//   mode: 'generic',
//   planId / planFilePath / worktreePath / baseBranch / phaseLabel: null,  // plan-only 字段全 null
//   initialPrompt: '继续 review #42 的反馈,重点看 race condition',  // = args.prompt 或默认
//   ignoredFields: [],  // 若 caller 在 generic 模式下传了 phase_label / plan_file_path 会列入
//   sessionId, adapter, cwd, teamId (默认 null), teamName (默认 null),
//   spawnDepth, sentAt, spawnPromptMessageId (默认 null), archived
// }
```

generic 模式适用场景:任意会话想 baton 交给新 session 但**不**走 plan-driven workflow(典型:普通会话讨论事情想换会话继续 / context 太满想换会话)。

> **baton 不计 spawn_depth**：hand_off_session 内部走 spawn handler 时传 `{ batonMode: true }` → spawn-guards 跳 depth check + setSpawnLink 写 `parentDepth`（lateral，不 +1）。理由：baton 单向交接（spawn 后立即 archive caller）任意时刻只 1 个 active session，**不构成 fork-bomb 风险**，N-phase 接力链不该撞默认 `mcpMaxSpawnDepth=3`。fan-out + spawn-rate guard 仍 enforce（防 spam baton 接力）。

> **archive 无条件原则**：默认行为无论 caller 是否有 untracked / dirty / 已加入 team 都归档（baton 单向交出 = caller 必须退出原会话），返回 `archived` 三态字段：
> - `'ok'` — 归档成功
> - `'failed'` — 归档失败（lifecycle / DB error），仅 `console.warn`，不阻塞 ok return；caller 用户从「历史」面板仍可查看接力前最后一段对话
> - `'skipped'` — caller 是 external caller（不在 sessions 表，理论被 denyExternalIfNotAllowed 拦下；防御性留口）
>
> 不允许 caller 传字段「不归档我」—— baton 语义保证「任意时刻单 in-flight session」，归档是流程的一部分非选项。

任一预检失败（plan-driven 模式:plan 文件不存在 / status ≠ in_progress / frontmatter 缺 worktree_path；任意模式:spawn 失败）立即返回 error 短路。**新 session system prompt 必须含 user CLAUDE.md「复杂 plan」节**（settingSources 包含 `'user'` 即可，应用内 SDK 会话默认满足）—— 否则 plan-driven 模式新 session 看 cold start prompt 不知道是什么意思。

### recoverer cwd 启发式 fallback（兜底）

如果 caller 取消归档继续给已收口的 plan-driven session 发消息(撞 cwd 失效),或者用户手动 `git worktree remove` 不走 archive_plan / 误删 / 跨设备同步丢目录,sdk-bridge.recoverer 会:
1. cwd precheck:`existsSync(sessionRepo.cwd)` → 不存在触发启发式 fallback
2. 启发式 1:路径含 `.claude/worktrees/<x>` → 取段之前部分(典型 hand-off 老 session 模式)
3. 启发式 2:父目录 walk 找第一个还存在的目录(安全边界:不超过 home)
4. 找到 fallback → emit info message + 强制走 jsonl missing fallback 同款下游(createThunk 不带 resume + renameSdkSession),CLI 历史失但应用层 events / file_changes / summaries 子表保留(SessionDetail 渲染走 events 表)
5. 找不到 → emit error message 清晰告诉用户 + throw,**不**emit「正在自动恢复」placeholder(误导)
