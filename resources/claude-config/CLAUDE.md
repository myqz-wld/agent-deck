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

应用环境跑 `deep-review` SKILL 时若 reviewer-codex teammate 失败（codex SDK 起不来 / OAuth 过期 / shell tool call cancel / sandbox 拒 / timeout / codex thread jsonl 缺失 fresh-session abort），可走「合规兜底（仍异构）」：lead 自己 Bash `run_in_background: true` 起外部 codex CLI（按 user 全局模板 `~/.claude/templates/reviewer-codex.sh.tmpl` 填，lead 自己执行而非 teammate），与 reviewer-claude teammate 仍构成 gpt-5.5 vs Opus 4.7 异构对。

> 通用 CLAUDE.md `§reviewer-codex 失败兜底` 只走「严禁同源化降级 / 提示用户决策」一条；本应用环境额外有上述 SKILL 内合规兜底分支。详 SKILL.md `§失败兜底` 表第 1 行。

---

## Agent Deck Universal Team Backend

跨 adapter 协作通过 Agent Deck MCP 10 tool（`mcp__agent-deck__spawn_session` / `send_message` / `list_sessions` / `get_session` / `shutdown_session` / `archive_plan` / `hand_off_session` / `enter_worktree` / `exit_worktree` / `shutdown_baton_teammates`）编排。teammate 调工具时走自己 SDK 会话的 canUseTool，**lead 不插手 teammate 权限审批**（失败弹给真人走 teammate 自己 session 的 PendingTab）。

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
2. **退化路径**：仍要交付 finding / codex 输出（不 abort）。`session_id` 反查：调 `mcp__agent-deck__list_sessions({adapter_filter: 'claude-code', status_filter: 'active'})` → 按以下顺序定位 lead：① displayName 含 "Lead-" 前缀 / ② displayName 非 reviewer-* 标识 / ③ team 内排除自己 sessionId 后唯一 active；3 条都失败走第 4 步终极兜底。`team_id` 反查：调 `list_sessions` 看自己 session 的 `teams[]` 字段（与 lead 共享的 team_id）。**注**：claude-config 端 lead 必为 claude-code adapter（claude SDK lead 不存在跨 adapter 子 session 当 lead 的场景），filter 减小结果集；codex-config 端 lead 可能跨 adapter（claude lead × codex teammate 等场景），不 filter 才能反查到 lead — 异构对偶设计
3. **副作用警告**：reply 不挂 `reply_to_message_id` 失去对话链锚点，DB / SessionDetail 看不出 reply 链关系；NO MSG ANCHOR 是**降级体验**，触发后 lead 应优先 shutdown + 重 spawn / 重发带 anchor 的 prompt 而非长期靠这个路径
4. **list_sessions 反查 lead 也失败**（多对 lead+teammate 同时跑歧义 / API 错）：直接把 finding / codex 输出落本 SDK session 的 assistant output（不调任何 mcp tool），lead 切到本 reviewer 的 SessionDetail UI 仍可看到

### enter_worktree / exit_worktree（MCP 替代方案）

claude 端首选 CLI builtin `EnterWorktree` / `ExitWorktree` 工具（直接调用建/退 git worktree + 切 cwd + 写 sessionRepo.cwd 子表）。本应用 MCP 等价 tool 用于以下场景（builtin 不适用时）:

- `mcp__agent-deck__enter_worktree({ plan_id, worktree_path?, base_commit?, base_branch?, plan_file_path? })`:创建 / 进入 worktree 目录(详 user CLAUDE.md §Step 2 EnterWorktree 节)
- `mcp__agent-deck__exit_worktree({ action: "keep" | "remove", worktree_path?, discard_changes?: false })`:退出 worktree

**何时走 MCP 替代**:
- 想避开 EnterWorktree CLI v2.1.112 stale base bug（详 user CLAUDE.md §Step 2 EnterWorktree §EnterWorktree CLI stale base bug callout）— MCP impl 显式用 HEAD 作 base 不撞 origin/<default> 落后陷阱
- 跨 adapter 测试 / 调试 — MCP 路径主路径(codex 必走 MCP),claude 端走同款 MCP 可对齐行为
- 需要明确写 `sessionRepo.cwd_release_marker` 字段（archive_plan 4 态预检场景必需）— MCP enter_worktree 自动写 marker，builtin EnterWorktree 不写。**默认 workflow** 仍 builtin EnterWorktree + 手工 `ExitWorktree(action:"keep")` → archive_plan 走 sessionRepo.cwd 兜底,无需切 MCP

详 codex 端 protocol layer `resources/codex-config/CODEX_AGENTS.md §enter_worktree / exit_worktree` 节(codex 必走 MCP,无 fallback)。

### plan hand-off 自动化：archive_plan

`archive_plan` 在 plan 完成后**原子执行** user CLAUDE §Step 4「完成」5 步：ff merge worktree branch → `base_branch` / 更新 frontmatter (`status=completed` + `final_commit` + `completed_at`) / mv plan → `<main-repo>/plans/<plan_id>.md` / **如 plan 有 spike-reports/ → mv `<plan-dir>/spike-reports/` → `<main-repo>/plans/<plan_id>/spike-reports/`** / 同步 `<main-repo>/plans/INDEX.md` / `git add` + commit / `git worktree remove` + `git branch -D`。caller 调用前必须先 `ExitWorktree(action: "keep")`。

**调用**：`mcp__agent-deck__archive_plan({ plan_id, worktree_path, base_branch?: <plan frontmatter.base_branch ?? "main">, plan_file_path?, changelog_id? })`(`base_branch` 默认值:schema 优先读 plan frontmatter.base_branch,缺失才 fallback "main")
**返回**：`{ archived_path, commit_hash, branch_deleted, worktree_removed, plans_index_action: 'created'|'appended'|'updated'|'unchanged', final_status, warnings: string[], spike_reports_archived: { src_path, dst_path } | null, archived: 'ok'|'failed'|'skipped', teammatesShutdown: { closed, failed, skipped } }`

**app-only 差异**：

- **预检短路**：plan status ≠ in_progress / worktree dirty / cwd 在 worktree 内 / detached HEAD 任一命中 → 立即返回 error，不做部分回滚（git 操作不可逆）
- **lead 必须先 ExitWorktree**：mcp 不能调 ExitWorktree CLI 内部 tool；cwd 在 worktree 内时 tool 直接 reject
- **自动归档 caller session**：plan 收口后默认归档 caller（baton 同款语义），返回 `archived` 三态字段；归档失败仅 warn 不阻塞 ok return
- **abandoned plan 不走本 tool**：tool 强制 `status=completed` 且入项目 git 归档；abandoned 走 user CLAUDE §Step 4 §中止 手工流程
- **changelog 引用归档** agent 自己写（tool 不做）
- **spike-reports/ 自动归档**：detect `<plan-dir-parent>/<plan-id>/spike-reports/` 存在 → mv 到 `<main-repo>/plans/<plan_id>/spike-reports/`（plan .md 同名子目录与 plan .md 平级，约定 plan .md 是主体 + 同名目录是 artifacts），spike-reports/ 子目录递归入 git 归档 commit。不存在 → skip 不报错（trivial plan 无 spike 是合法场景）。mv 失败（EXDEV 跨 fs / perm）→ warnings 落 hint「spike-reports archive failed: ... Manually run \`mkdir -p && mv && git add+commit --amend\`」+ 不阻塞 ok return。`spike_reports_archived` 字段告诉 caller 实际归档结果（null = skip / `{src_path, dst_path}` = 成功）
- **followup 20260515 (a)+(b)+(c)+(d) UX 完善**：
  - fallback 链 `<main-repo>/.claude/plans/` > `<main-repo>/plans/` > `~/.claude/plans/`(加中间档兜底本项目实际惯例)
  - `plan_file_path` 文件名 stem 必须 == `plan_id`(impl 层 reject 防 silent unlink)
  - INDEX 4 列 canonical `| 文件 | 状态 | 关联 changelog | 概要 |` + smart update existing 行(替换 status / changelog / description)
  - `changelog_id` optional string + csv(单值 `"122"` / 多值 `"121,122"`),拼成 markdown link 写入 INDEX 第 3 列;不传时 smart update 保留老 4 列 changelog 列 / 旧 2 列或新 append 用 `—` placeholder
  - `plans_index_action` 四态 enum 替代旧 boolean,让 caller 区分 INDEX 行真正发生的事情
  - `warnings` non-fatal warning 数组(如 `.claude/plans/<id>.md` 与 `plans/<id>.md` 同 id 双存覆盖警告 — 走 warn 而非 reject)
  - 7 phase post-ff-merge 失败专用 phaseHint 给具体 manual recovery 决策树(替代旧通用 hint)
- **mainRepo dirty precheck 精确化（plan deep-review-batch-a1-b-followup-r3-20260519 §不变量 5）**：旧版 mainRepo 任意 dirty 全场 fail-fast；新版仅 reject 三具体路径 `{archivedPath, indexPath, planFilePath}` 命中 dirty / staged / untracked / R rename / C copy（含 old/new path 任一命中）— 其他无关 dirty 文件降 warning + commit message 注脚（commit pathspec 隔离不吞）。precheck 失败时 hint 软引导 caller fix 撞 critical paths 后重 invoke archive_plan，**或** 走 §escape hatch: shutdown_baton_teammates 补跑 baton-cleanup phase 1（如 caller 必须手工归档场景）— 不硬技术阻断手工归档（user CLAUDE.md §Step 4 5 步手工归档仍是合法 fallback）

### escape hatch: shutdown_baton_teammates

`shutdown_baton_teammates` 让 caller 手工归档 plan 后**补跑** baton-cleanup phase 1（同 team 其他 active+dormant teammate 一并 close + `team_member.left_at` 软退出）。仅供 archive_plan 撞 precheck fail / 历史 dormant 残留清理使用。

**调用**：`mcp__agent-deck__shutdown_baton_teammates({ caller_session_id?, plan_id? })`
**返回**：`{ closed: string[], failed: Array<{sessionId,reason}>, skipped: null, planId: string | null }`

**典型场景**（plan deep-review-batch-a1-b-followup-r3-20260519 §D4 F1c）：

archive_plan tool 撞 mainRepo dirty / cwd resilience guard 等 precheck fail → caller 走 user CLAUDE.md §Step 4 5 步手工归档绕过 archive_plan tool（commit + mv plan + git worktree remove + branch -D）→ runBatonCleanup phase 1 没被调到 → 同 team teammate（reviewer-claude / reviewer-codex 等）自然衰减成 dormant 但**没** closed，占内存 + SDK live query。本 tool 让 caller 显式补跑 phase 1。

**与 archive_plan 的边界**：

- archive_plan 是 plan 收口 tool（git ff-merge / mv plan / commit / git worktree remove）+ default baton-cleanup phase 1+2(plan hand-off-session-adopt-teammates-20260520 Phase 3 删 phase 1 opt-out 字段,archive_plan 不再支持 phase 1 跳过)
- `shutdown_baton_teammates` 是「补跑 phase 1」的独立 tool，**不**做任何 git/fs 归档操作；**不**调 phase 2 archive caller（caller 决定何时 archive；典型场景 caller 已手工归档完毕）

**错误契约**（plan §F1c R2 codex MED-4）：

- caller 不在任何 team 是 lead（caller 是 teammate / 无 active membership / 所有 caller-lead 团队都已 archive）→ **error + hint**（**非** silent return success — escape hatch 是 caller 显式请求 cleanup，no-op 误导 caller 以为成功了）。hint 指向 IPC `TeamShutdownAllTeammates` handler 或 UI Team 面板「Shutdown all teammates」按钮（不要求 caller 是 lead）
- helper 自身抛错（agentDeckTeamRepo SQLite locked / sessionManager.close abort 等）→ error + console.warn，**不**像 archive_plan / hand_off_session 兜底 warn 不阻塞（本 tool 是 escape hatch，helper 失败就是补跑没成功，需让 caller 显式知道）

**deny external caller**（types.ts EXTERNAL_CALLER_ALLOWED.shutdown_baton_teammates = false）：sessionManager.close 是写操作 + caller=lead 反查需要真实 caller_session_id，绝不允许 stdio external client 调用（避免被恶意 mcp client 利用清理任意 team session）。

### plan hand-off 自动化：hand_off_session

`hand_off_session` 起新 SDK session 接力 + 自动归档 caller。**双模式**：plan-driven 传 `plan_id`（读 plan frontmatter，要求 `status: in_progress` + 有 `worktree_path`，cold start prompt = `按 <plan-abs-path> 接力`，可附 `phase_label`）；generic 不传 `plan_id`（不读 plan，cold start prompt = `args.prompt` 或默认「从上一个会话接力继续工作」）。

**调用**：`mcp__agent-deck__hand_off_session({ plan_id?, phase_label?, prompt?, cwd?, adapter?: "claude-code", team_name?, permission_mode?, plan_file_path?, archive_caller?: true, adopt_teammates?: false })`
**返回**：`{ mode: 'plan'|'generic', planId, planFilePath, worktreePath, initialPrompt, sessionId, cwd, teamId, teamName, spawnPromptMessageId, archived, teammatesShutdown, ... }`

**app-only 差异**：

- **cwd resilience**：plan-driven 默认 `cwd = mainRepo`（fallback 链 `args.cwd > resolved.mainRepo > resolved.worktreePath`），让 sessionRepo.cwd 在 worktree 被 archive_plan 删后仍 valid；新 session 自己按 user CLAUDE §Step 3 cold-start `EnterWorktree(path: worktreePath)` 进 worktree。generic 默认 `cwd = caller cwd`
- **baton 不计 spawn_depth（仅 archive_caller=true 时）**：默认 `archive_caller=true` 路径内部 spawn 传 `batonMode: true` 跳 depth check + 写 `parentDepth`（lateral，不 +1）。理由：baton 单向交接（spawn 后立即 archive caller）任意时刻只 1 个 active session，**不构成 fork-bomb 风险**，N-phase 接力链不该撞默认 `mcpMaxSpawnDepth=3`。fan-out + spawn-rate guard 仍 enforce。**`archive_caller: false` 退化 normal spawn**：caller 不归档 = caller 与新 session 同时 active = 接近 spawn 用法，`resolveBatonRoleForSpawn` 返 `batonMode=false` 不跳 depth check（防止 caller 用 opt-out 路径绕过 spawn_depth 限制开 N-phase fork-bomb）
- **archive 默认 true,可 opt-out**：caller 无论 untracked / dirty / 已加入 team 都归档（default）；typical baton 语义「任意时刻单 in-flight session」自然成立。**例外 opt-out**：caller 显式传 `archive_caller: false` 跳过归档（罕见场景：lead 起多个 hand-off 子任务并行做事自己仍想看 reviewer reply / 出 summary；debug 工具想起新 session 实测某 plan 但 caller 仍要观察）。`archive_caller: false` 时 ok return.archived === "skipped"
- **default 不加 team**：baton 单向交接不强加 lead/teammate 关系;显式 `team_name` 才启用通信
- **adopt_teammates 选 in 接管 caller 同 team 当 lead**(plan hand-off-session-adopt-teammates-20260520 Phase 4):default false 走纯 baton(原 teammate 与新 session 失去 shared active team,`send_message` 撞 no-shared-team)。**`adopt_teammates: true`** 让新 session 接管 caller 同 team 当 lead,原 teammate 与新 session 共享 active team 可继续 send_message 沟通。**N5 ≥1 lead 硬约束**:caller 在所有 team 都不是 lead → handler spawn 之前 fail-fast 返 error,不 spawn / 不 archive caller。**N2.c 互斥**:adopt_teammates=true 与 args.team_name 不可同传(zod refine reject — adopt 路径自动过继 caller 自己 team,与显式额外 team 语义冲突)。Detail 见 ok return.adopted 字段:`{ preserved, failed, teamsTotal, teamsAdopted, firstTeamId } | null`(adopt_teammates: true 时 non-null)。
- **预检短路**：plan-driven 模式 plan 文件不存在 / status ≠ in_progress / frontmatter 缺 `worktree_path` / spawn 失败 → 立即返回 error
- **新 session 必须含 user CLAUDE「复杂 plan」节**（`settingSources: ['user', ...]` 自动满足），否则 plan-driven cold start prompt 不被识别
- **典型主动触发（generic mode）**：当前 cwd 不适合手头任务（cwd 已失效 / 不属目标 repo / 用户明示换目录 / 跨 repo 任务）→ 不要在当前 session 强行 `cd` / 跨目录绝对路径，用 generic mode 显式传新 `cwd` + 自包含 `prompt` 接力到正确目录
- **prompt 装不下完整 context 时**（必要信息务必传递完整，避免 hand-off 丢失大量上下文）：caller 先把 context 落盘到 `/tmp/handoff-<id>.md`（临时文件不用清理），prompt 起手写「先 `Bash: cat <abs-path>` 再按文件内指令推进」让新 session cold-start 第一步读全
- **想保留 caller 不归档** → 两个选项：① `hand_off_session({..., archive_caller: false})` 显式 opt-out（详上方 archive 默认 true 节）；② `spawn_session(cwd:<目标>, prompt:<打包信息>)` 而非 hand_off_session（spawn 出新 session 但不切换接力身份,适合并行子任务）

### recoverer cwd 启发式 fallback（兜底）

caller 取消归档继续给已收口 plan-driven session 发消息（撞 cwd 失效）/ 用户手动 `git worktree remove` 不走 archive_plan / 跨设备同步丢目录 → sdk-bridge.recoverer 启发式找仍存在的祖先目录当 cwd 兜底（worktree 路径取段之前部分 / 父目录 walk 不超过 home），找到 → emit info + 强制走 jsonl missing fallback 同款下游（CLI 历史失但应用层 events / file_changes / summaries 子表保留）；找不到 → emit error 清晰告诉用户。算法详 `src/main/adapters/claude-code/sdk-bridge/recoverer.ts:103-220`。
