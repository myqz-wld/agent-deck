<!-- 由 resources/codex-config/CODEX_AGENTS.md 打包注入到 codex SDK 子进程加载链(`~/.codex/AGENTS.md`)末尾;维护说明详 resources/codex-config/README.md(若存在)与 resources/claude-config/README.md 同款。 -->

--- Agent Deck 应用环境约定（codex 视角，随应用打包注入到每个 codex SDK 会话）---

# 应用环境约定（codex 视角）

> 本文件是 **codex 视角** 的应用环境约定。**claude 视角**等价物在 `resources/claude-config/CLAUDE.md`(同应用打包同步注入 claude SDK system prompt 末尾)。两份 file 协议层语义对齐(Wire format / send_message / archive_plan / hand_off_session / shared-team 约束同款),只在**纯 codex 工具差异处**(`shell` vs `Bash` tool / `~/.codex/AGENTS.md` 加载点 / `sandboxMode` `approvalPolicy` 而非 claude 的 `--permission-mode` / 无 native EnterWorktree CLI 必须走 MCP tool)分别说明。
>
> **加载范围**：codex SDK 起 thread 时自动加载 `~/.codex/AGENTS.md`(本应用 build-time installer 把本文件内容同步到该路径)。codex 子进程 system prompt 末尾追加本文件内容,与 claude SDK `settingSources: ['user','project','local']` 自动加载 `~/.claude/CLAUDE.md` 是平行机制。

## 应用环境差异（Δ user CLAUDE.md）

### 协议覆盖：teammate 协作走 mcp tool

本应用环境(agent-deck) teammate 协作走 mcp tool(详 §Agent Deck Universal Team Backend 节)。teammate 通过 `send_message` 发消息 → universal-message-watcher → adapter.receiveTeammateMessage → adapter.sendMessage → codex SDK 把 message 喂给 receiver thread 自动注入 conversation flow(receiver codex 看到 user-role message 直接 act on it,无需主动 poll)。

### codex 无 native EnterWorktree / ExitWorktree CLI → 必须走 MCP

claude SDK 在 CLI binary 内置 `EnterWorktree` / `ExitWorktree` 工具(直接调用建/退 git worktree + 切 cwd)。**codex CLI 没有等价 builtin** — 想从 codex session 内进/退 worktree,只能调本应用提供的 MCP tool:
- `mcp__agent-deck__enter_worktree({ plan_id, base?: "HEAD" })`:创建 / 进入 worktree 目录 + 切当前 SDK session cwd
- `mcp__agent-deck__exit_worktree({ action: "keep" | "remove", discard_changes?: false })`:退出 worktree(同 claude 端 ExitWorktree 语义)
- 详 §Agent Deck Universal Team Backend §enter_worktree / exit_worktree 节

claude 视角同款 tool 也存在(MCP 通用),claude 端用 CLI builtin 作首选。codex 端**无 fallback**必须走 MCP。

### reviewer-claude 失败 → 应用环境额外有「合规兜底」分支(对称 claude 视角)

应用环境跑 `deep-review` SKILL 时若 reviewer-claude teammate 失败(claude SDK 起不来 / OAuth 过期 / sandbox 拒 / timeout / claude jsonl 缺失 fresh-session abort),可走「合规兜底(仍异构)」:lead 自己 `shell` 起外部 claude CLI(按 user 全局模板 `~/.claude/templates/reviewer-claude.sh.tmpl` 填,lead 自己执行而非 teammate),与 reviewer-codex teammate 仍构成 Opus 4.7 vs gpt-5.5 异构对。

> 通用 CLAUDE.md `§reviewer-codex 失败兜底` 只走「严禁同源化降级 / 提示用户决策」一条;本应用环境额外有上述 SKILL 内合规兜底分支(对称双 reviewer 都适用)。详 SKILL.md `§失败兜底` 表。

---

## Agent Deck Universal Team Backend

跨 adapter 协作通过 Agent Deck MCP 9 tool(`mcp__agent-deck__spawn_session` / `send_message` / `list_sessions` / `get_session` / `shutdown_session` / `archive_plan` / `hand_off_session` / `enter_worktree` / `exit_worktree`)编排。teammate 调工具时走自己 codex SDK 会话的 `approvalPolicy` + `sandboxMode`,**lead 不插手 teammate 权限审批**(失败弹给真人走 teammate 自己 session 的 PendingTab)。

### 三个核心约定(lead 角度)

1. **spawn 首轮锚点**:`spawn_session` 返回 `spawnPromptMessageId: string | null`(仅当传 `team_name` 且 caller 在 sessions 表时非空),是首轮 prompt 在 messages 表的 placeholder id。teammate first turn 完成后调 `send_message({reply_to_message_id: spawnPromptMessageId, ...})` 回复,reply 自动注入 lead conversation。lead 不需主动 poll —— 看到 user-role wire-prefixed message 即知 reply 到了
2. **后续轮次锚点**:`send_message` 返回 `{ sessionId, teamId, messageId, replyToMessageId, sentAt, queued: true }`。caller 用 `messageId` 在 DB 查 reply chain(如有审计需求);正常对话不需要 — receiver 收到 message 后会**自动通过 wire prefix `[msg <id>][sid <senderSid>]`** 提到 caller 的 messageId 当 `reply_to_message_id` 调 send_message reply 回来。`replyToMessageId` 仅当 caller 调 send 时显式传入 `reply_to_message_id` 才有值,开新话题(首条 message / 不挂 reply chain)时为 `null`
3. **shutdown 不删数据**:`shutdown_session` 只标 lifecycle='closed' + abort SDK live query;events / file_changes / summaries / messages 子表保留,lead 在裁决报告里仍可引用。`team_member` 通过 `left_at` 软退出(行不删,archive 时归档面板仍可看 member 历史);`spawn_link` 父子关系全保留(list_sessions(spawned_by_filter) 跨 lifecycle 全见,跨会话救火依赖此)

> **dormant ≠ 丢 mental model**:lifecycle scheduler 转 dormant 只 abort codex SDK live query + 清 in-process `codexBySession` Map,**不删 thread jsonl**(codex 把 thread 历史持久化到 `~/.codex/sessions/<thread-id>.jsonl`);下一次 `send_message` 自动通过 `codex.resumeThread(threadId, options)` 复原对话历史。**唯一例外**:thread jsonl 缺失(用户手动删 `~/.codex/sessions/` / 应用重装 / 跨设备同步未带)走 hard fail fallback → teammate 触发 `⚠ FRESH SESSION` warn 必须重 spawn。
>
> 实操:复用直接 `send_message`;彻底不再用才 `shutdown_session`。机制详 `src/main/adapters/codex-cli/sdk-bridge/recoverer.ts`。

### send_message 一统消息发送

```ts
const result = await mcp__agent-deck__send_message({
  session_id: <target-sid>,           // target session id(receiver)
  team_id: <team-id>,                  // optional:caller / target 共享多 team 时必填,single-team 自动 resolve
  text: <message body>,
  reply_to_message_id: <messageId>,    // optional:链接 reply chain;从收到的 wire prefix `[msg <id>]` 提取
  caller_session_id: callerSid,        // codex teammate 走 MCP HTTP transport 时由 per-session token 反查自动填入,无需 caller 自己传
});
// result = { sessionId, teamId, messageId, replyToMessageId, sentAt, queued: true }
```

**发消息(普通 / reply)**:都用 `send_message`。reply 是普通 send_message 加 `reply_to_message_id` 字段(链接 DB 对话链)。

**收消息(自动注入 conversation flow)**:universal-message-watcher 异步把 message dispatch 给 receiver adapter → codex adapter.receiveTeammateMessage 把消息加 wire prefix `[from <senderName> @ <adapter>][msg <messageId>][sid <senderSessionId>]` → adapter.sendMessage 喂给 receiver codex SDK thread → receiver codex 看到 user-role message 直接处理。

### 跨会话救火:list_sessions(spawned_by_filter)

lead context 重置 / 重启后捡 stranded reviewer:`list_sessions(spawned_by_filter:'<old_lead_sid>', status_filter:'active')` 拉自己以前 spawn 的 active reviewer;按 sessionId 调 `send_message` 发新 prompt(receiver reply 通过 wire prefix `[msg <id>][sid <senderSid>]` 自动挂 reply chain 注入 lead conversation,与 §三个核心约定 §2 后续轮次锚点同款);收尾走 `shutdown_session`。

> ⚠️ **shared-team 前置约束**:`send_message` 必须在 caller session 与 target reviewer 至少共享一个 active team 时才能 dispatch(否则报 `no-shared-team` 立即 reject,不入 messages 表)。
> - **同 caller session(context 重置 / compaction)**:sessionId 不变 → team_member 关系不变 → 直接 `list_sessions(spawned_by_filter)` 捡回来 + `send_message` 即可
> - **真换了 caller session**(应用重启 / 用户手动新开 / hand_off_session 默认不携 team 起新 session):新 caller 不在原 team 内 → `send_message` 必报 `no-shared-team` → 必须先满足以下任一条件:
>   1. 调 `spawn_session({adapter:'codex-cli', team_name:<old-team-name>, ...})` 重起一对 reviewer(旧的走 `shutdown_session` 收尾,避免 ghost)
>   2. 通过 UI 手动把新 caller 加入旧 team(应用 → Team 面板 → Add Member)
>   3. `hand_off_session` 起新 session 时显式传 `team_name:<old-team-name>` 让新 session 直接落入 team(仅当 plan 接力同 team 场景;baton 单向交接默认场景不加 team)
> - 选项 1 简单粗暴但丢 reviewer 跨轮 mental model;选项 2/3 保留 mental model 推荐

### Wire format / regex / DB invariant

teammate 端协议约束(`[from <name> @ <adapter>][msg <id>][sid <senderSid>]\n` 三段 wire prefix / regex 提 messageId + senderSessionId / 用 send_message 回 / DB messages.body 不含 wire prefix 的 invariant)已强约束在 reviewer-{claude,codex}.md「核心纪律」节,**lead 不需关心**这些细节。Wire format 字段 schema 与字段语义 SSOT 在 `src/main/agent-deck-mcp/tools/schemas.ts`(应用 build 时把 description 注入 SDK system prompt 的 tool definitions)。

**wire format id invariant**:`messageId` / `senderSessionId` 都由 `crypto.randomUUID()` 生成(v4 UUID lowercase hex + hyphen,charset `[0-9a-f-]{36}`),regex `/\[msg ([0-9a-f-]+)\]\[sid ([0-9a-f-]+)\]/` 与该 charset 严格对齐。

### NO MSG ANCHOR 退化路径(reviewer 端 fallback)

reviewer agent 收到的 user message 顶部如果没找到 `[msg <id>][sid <senderSid>]` 双锚点 wire prefix(典型:lead context 重置后用裸文本 ping / 第三方 dispatch 路径丢前缀),按下面 fallback 处理:

1. reply 顶部硬性输出 `⚠ NO MSG ANCHOR — prompt 顶部没找到 [msg <id>][sid <senderSessionId>] wire prefix,本 reply 没法挂 reply_to_message_id 进 lead 对话链;建议 lead 通过 send_message 重新发本轮 prompt 提供 anchor`
2. **退化路径**:仍要交付 finding / codex 输出(不 abort)。`session_id` 反查:调 `mcp__agent-deck__list_sessions({status_filter: 'active'})`(不 filter adapter — lead 可能是 claude-code / codex-cli 任一) → 按以下顺序定位 lead:① displayName 含 "Lead-" 前缀 / ② displayName 非 reviewer-* 标识 / ③ team 内排除自己 sessionId 后唯一 active;3 条都失败走第 4 步终极兜底。`team_id` 反查:调 `list_sessions` 看自己 session 的 `teams[]` 字段(与 lead 共享的 team_id)
3. **副作用警告**:reply 不挂 `reply_to_message_id` 失去对话链锚点,DB / SessionDetail 看不出 reply 链关系;NO MSG ANCHOR 是**降级体验**,触发后 lead 应优先 shutdown + 重 spawn / 重发带 anchor 的 prompt 而非长期靠这个路径
4. **list_sessions 反查 lead 也失败**(多对 lead+teammate 同时跑歧义 / API 错):直接把 finding / codex 输出落本 codex SDK session 的 assistant output(不调任何 mcp tool),lead 切到本 reviewer 的 SessionDetail UI 仍可看到

### enter_worktree / exit_worktree(codex 端必走 MCP)

codex SDK session 内进 / 退 git worktree 必须通过本应用 MCP tool(codex CLI 无 native EnterWorktree / ExitWorktree builtin)。

**调用**:`mcp__agent-deck__enter_worktree({ plan_id, worktree_path?, base_commit?, base_branch?, plan_file_path? })`
- `plan_id`:同 plan frontmatter `plan_id`,worktree 目录名 = `<main-repo>/.claude/worktrees/<plan_id>`,branch 名 = `worktree-<plan_id>`(P5 Round 1 reviewer-codex M1 修法 — 实际 schema 用 `base_commit` / `base_branch` 两字段而非旧文档的 `base`)
- `base_commit`(optional):caller 显式 commit hash / ref(最高优先级)
- `base_branch`(optional):caller 显式 branch 名
- `worktree_path`(optional):override 默认 worktree 目录路径
- `plan_file_path`(optional):override plan 文件路径
- **base 优先级链** 5 态:(1) `args.base_commit` → `'arg-base-commit'` (2) `args.base_branch` → `'arg-base-branch'` (3) plan frontmatter `base_commit` → `'frontmatter-base-commit'` (4) plan frontmatter `base_branch` → `'frontmatter-base-branch'` (5) main repo HEAD → `'head'`。**避开 EnterWorktree CLI stale base bug**(claude 端 builtin v2.1.112 默认用 `origin/<default>` 落后本地 HEAD;MCP impl 走 HEAD 不撞此坑)
- 副作用:创建 worktree 目录 + 新 branch + setCwdReleaseMarker(让 archive_plan 4 态预检状态 (b) 放过 codex caller)。**不**自动切 codex SDK session cwd(codex SDK session cwd 在 spawn 时 frozen,后续 shell tool 走子 shell `cd` 进 worktree)
- 返回:`{ worktreePath: string, branchName: string, baseCommit: string, baseSource: 'arg-base-commit' | 'arg-base-branch' | 'frontmatter-base-commit' | 'frontmatter-base-branch' | 'head', markerSet: boolean }`

**调用**:`mcp__agent-deck__exit_worktree({ action: "keep" | "remove", worktree_path?, discard_changes?: false })`
- `keep`:仅 clearCwdReleaseMarker(让 archive_plan 4 态预检走 marker null 路径),保留 worktree 目录 + branch(常用 — 准备 archive_plan 前的标准操作 since archive_plan 自己也清 marker)
- `remove`:同 keep + `git worktree remove` + `git branch -d/-D`(P5 Round 1 reviewer-codex M4 修法 — 默认 `-d` 拒删未合并 commit;`discard_changes: true` 切 `-D` 强制删 + 同时跳过 dirty 预检)
- `worktree_path`(optional):caller 显式覆盖,通常省略让 impl 自动从 marker 反查
- 返回:`{ worktreePath, action, branchDeleted: boolean, worktreeRemoved: boolean, markerCleared: boolean }`

### plan hand-off 自动化:archive_plan

`archive_plan` 在 plan 完成后**原子执行** user CLAUDE §Step 4「完成」5 步:ff merge worktree branch → `base_branch` / 更新 frontmatter (`status=completed` + `final_commit` + `completed_at`) / mv plan → `<main-repo>/plans/<plan_id>.md` / 同步 `<main-repo>/plans/INDEX.md` / `git add` + commit / `git worktree remove` + `git branch -D`。caller 调用前必须先 `exit_worktree(action: "keep")`(codex 端走 MCP,不是 claude builtin)。

**调用**:`mcp__agent-deck__archive_plan({ plan_id, worktree_path, base_branch?: "main", plan_file_path?, changelog_id? })`
**返回**:`{ archived_path, commit_hash, branch_deleted, worktree_removed, plans_index_action: 'created'|'appended'|'updated'|'unchanged', final_status, warnings: string[], archived: 'ok'|'failed'|'skipped', teammatesShutdown: { closed, failed, skipped } }`

**app-only 差异**:

- **预检短路**:plan status ≠ in_progress / worktree dirty / **caller session cwd 在 worktree 内** / detached HEAD 任一命中 → 立即返回 error,不做部分回滚(git 操作不可逆)。**codex 端 cwd 预检**走 sessionRepo.cwd + `cwd_release_marker` 字段(HIGH-C 修法 4 态分流),不直接读 process.cwd
- **lead 必须先 exit_worktree**:tool 内不能调 exit_worktree;cwd 在 worktree 内时 tool 直接 reject
- **自动归档 caller session**:plan 收口后默认归档 caller(baton 同款语义),返回 `archived` 三态字段;归档失败仅 warn 不阻塞 ok return
- **abandoned plan 不走本 tool**:tool 强制 `status=completed` 且入项目 git 归档;abandoned 走 user CLAUDE §Step 4 §中止 手工流程
- **changelog 引用归档** agent 自己写(tool 不做)
- **followup 20260515 (a)+(b)+(c)+(d) UX 完善**:
  - fallback 链 `<main-repo>/.claude/plans/` > `<main-repo>/plans/` > `~/.claude/plans/`(加中间档兜底本项目实际惯例)
  - `plan_file_path` 文件名 stem 必须 == `plan_id`(impl 层 reject 防 silent unlink)
  - INDEX 4 列 canonical `| 文件 | 状态 | 关联 changelog | 概要 |` + smart update existing 行(替换 status / changelog / description)
  - `changelog_id` optional string + csv(单值 `"122"` / 多值 `"121,122"`),拼成 markdown link 写入 INDEX 第 3 列;不传时 smart update 保留老 4 列 changelog 列 / 旧 2 列或新 append 用 `—` placeholder
  - `plans_index_action` 四态 enum 替代旧 boolean,让 caller 区分 INDEX 行真正发生的事情
  - `warnings` non-fatal warning 数组(如 `.claude/plans/<id>.md` 与 `plans/<id>.md` 同 id 双存覆盖警告 — 走 warn 而非 reject)
  - 7 phase post-ff-merge 失败专用 phaseHint 给具体 manual recovery 决策树(替代旧通用 hint)

### plan hand-off 自动化:hand_off_session

`hand_off_session` 起新 SDK session 接力 + 自动归档 caller。**双模式**:plan-driven 传 `plan_id`(读 plan frontmatter,要求 `status: in_progress` + 有 `worktree_path`,cold start prompt = `按 <plan-abs-path> 接力`,可附 `phase_label`);generic 不传 `plan_id`(不读 plan,cold start prompt = `args.prompt` 或默认「从上一个会话接力继续工作」)。

**调用**:`mcp__agent-deck__hand_off_session({ plan_id?, phase_label?, prompt?, cwd?, adapter?: "codex-cli", team_name?, codex_sandbox?, plan_file_path?, archive_caller?: true, adopt_teammates?: false })`
**返回**:`{ mode: 'plan'|'generic', planId, planFilePath, worktreePath, initialPrompt, sessionId, cwd, teamId, teamName, spawnPromptMessageId, archived, teammatesShutdown, ... }`

**app-only 差异**:

- **cwd resilience**:plan-driven 默认 `cwd = mainRepo`(fallback 链 `args.cwd > resolved.mainRepo > resolved.worktreePath`),让 sessionRepo.cwd 在 worktree 被 archive_plan 删后仍 valid;新 session 自己按 user CLAUDE §Step 3 cold-start 调 MCP `enter_worktree(plan_id)` 进 worktree(codex 端必走 MCP,不是 claude builtin)。generic 默认 `cwd = caller cwd`
- **baton 不计 spawn_depth(仅 archive_caller=true 时)**:默认 `archive_caller=true` 路径内部 spawn 传 `batonMode: true` 跳 depth check + 写 `parentDepth`(lateral,不 +1)。理由:baton 单向交接(spawn 后立即 archive caller)任意时刻只 1 个 active session,**不构成 fork-bomb 风险**,N-phase 接力链不该撞默认 `mcpMaxSpawnDepth=3`。fan-out + spawn-rate guard 仍 enforce。**`archive_caller: false` 退化 normal spawn**:caller 不归档 = caller 与新 session 同时 active = 接近 spawn 用法,`resolveBatonRoleForSpawn` 返 `batonMode=false` 不跳 depth check(防止 caller 用 opt-out 路径绕过 spawn_depth 限制开 N-phase fork-bomb)
- **archive 默认 true,可 opt-out**(P5 Round 1 reviewer-codex M2 修法 — 文档与 schema 对齐):caller 无论 untracked / dirty / 已加入 team 都归档(default);typical baton 语义「任意时刻单 in-flight session」自然成立。**例外 opt-out**:caller 显式传 `archive_caller: false` 跳过归档(罕见场景:lead 起多个 hand-off 子任务并行做事自己仍想看 reviewer reply / 出 summary;debug 工具想起新 session 实测某 plan 但 caller 仍要观察)。`archive_caller: false` 时 ok return.archived === "skipped"
- **default 不加 team**:baton 单向交接不强加 lead/teammate 关系;显式 `team_name` 才启用通信
- **adopt_teammates 选 in 接管 caller 同 team 当 lead**(plan hand-off-session-adopt-teammates-20260520 Phase 4):default false 走纯 baton(原 teammate 与新 session 失去 shared active team,`send_message` 撞 no-shared-team)。**`adopt_teammates: true`** 让新 session 接管 caller 同 team 当 lead,原 teammate 与新 session 共享 active team 可继续 send_message 沟通。**N5 ≥1 lead 硬约束**:caller 在所有 team 都不是 lead → handler spawn 之前 fail-fast 返 error,不 spawn / 不 archive caller。**N2.c 互斥**:adopt_teammates=true 与 args.team_name 不可同传(zod refine reject + handler 防御性硬约束 — adopt 路径自动过继 caller 自己 team,与显式额外 team 语义冲突)。Detail 见 ok return.adopted 字段:`{ preserved, failed, teamsTotal, teamsAdopted, firstTeamId } | null`(adopt_teammates: true 时 non-null)。
- **预检短路**:plan-driven 模式 plan 文件不存在 / status ≠ in_progress / frontmatter 缺 `worktree_path` / spawn 失败 → 立即返回 error
- **新 session 必须含 user CLAUDE「复杂 plan」节 cold-start protocol 5 步**:codex SDK 加载链是 `~/.codex/AGENTS.md`(本文件),**不**自动加载 user CLAUDE.md(claude 端走 `settingSources: ['user',...]` 自动加载,codex 端无对等机制)。本应用环境**已在 §plan cold-start protocol(codex 端) 节 inline 5 步**让 codex 收到 `按 <plan-abs-path> 接力` 字面提示后能正确执行;若该节缺失或被裁剪,caller 起 cold-start prompt 时必须显式把 5 步 inline 进 prompt
- **典型主动触发(generic mode)**:当前 cwd 不适合手头任务(cwd 已失效 / 不属目标 repo / 用户明示换目录 / 跨 repo 任务) → 不要在当前 session 强行 `cd` / 跨目录绝对路径(codex shell tool 切 cwd 不持久跨 turn),用 generic mode 显式传新 `cwd` + 自包含 `prompt` 接力到正确目录
- **prompt 装不下完整 context 时**(必要信息务必传递完整,避免 hand-off 丢失大量上下文):caller 先把 context 落盘到 `/tmp/handoff-<id>.md`(临时文件不用清理),prompt 起手写「先 `shell: cat <abs-path>` 再按文件内指令推进」让新 session cold-start 第一步读全
- **想保留 caller 不归档** → 两个选项:① `hand_off_session({..., archive_caller: false})` 显式 opt-out(详上方 archive 默认 true 节);② `spawn_session(cwd:<目标>, prompt:<打包信息>)` 而非 `hand_off_session`(spawn 出新 session 但不切换接力身份,适合并行子任务)

### plan cold-start protocol(codex 端 5 步)

新 codex SDK session 收到 hand_off_session 注入的 cold-start prompt(典型字面:`按 <plan-abs-path> 接力(Phase: <phase_label>)`)时,**必做** 5 步:

1. `shell: cat <plan-abs-path>` 读 plan 全文(P5 Round 1 reviewer-claude INFO 修法:codex CLI 默认无 native Read tool,与 claude CLI 不同 — 跨会话第一次读「长期存在 + 其他会话动过的文件」务必走 `shell: cat` 走真 fs。本规约对 codex 端单方有效;claude 端有 Read tool 缓存陷阱另规)
2. 从 frontmatter 拿 `worktree_path` + `plan_id` → 调 `mcp__agent-deck__enter_worktree({ plan_id, base: <frontmatter.base_commit> })` 进 worktree(codex 无 native EnterWorktree CLI 必须走 MCP;`base` 显式传 frontmatter 的 `base_commit` 避撞 EnterWorktree CLI stale base bug)
3. 自检:`shell: git -C <worktree_path> rev-parse HEAD` 与 `git -C <worktree_path> log --oneline -3`,确认 HEAD = frontmatter `base_commit` / `final_commit` 或之后
4. 按 plan **§下一会话第一步** 节直接动手:**不重新讨论已记录的 §设计决策**;**所有指向代码资产的路径换 worktree 前缀**(`.claude/worktrees/<plan_id>/...`);plan 「§下一会话第一步」描述的「先 X 再 Y 再 Z」级别动作按字面执行
5. 进度变更 / §设计决策 / §不变量 修订必须先告诉用户征得确认(plan §Agent 自主 hand-off 授权 节列具体例外清单)

> claude 视角的对应 protocol 在 user CLAUDE.md §复杂 plan §Step 3 §选项 A;codex 端无 user CLAUDE.md 自动加载机制(claude 端走 `settingSources` 自动加载),本节是 codex 端等价物 inline。

### codex SDK 特有:per-session token / spawn options default

codex teammate spawn(`adapter: 'codex-cli'`)走 options-builder 默认 enforce 一组 spawn options(reviewer-* 必需):
- `sandboxMode: 'workspace-write'`(SDK 默认档;`approvalPolicy: 'never'` 配合不弹审批)
- `approvalPolicy: 'never'`(SDK 无 UI 弹审批会挂)
- `networkAccessEnabled: true`(reviewer-codex teammate 调 OpenAI API;cross-adapter pair 时 reviewer-claude 跑在 claude SDK 端不走本 default)
- `additionalDirectories: ['~/.claude', '~/.codex', '/tmp']`(reviewer 跨目录读 plan / claude config / codex config 文件 + cache 中间文件落 `/tmp`)
- caller 显式传同字段则覆盖 default;`narrowToCodexOpts` filter 掉 claude 专属字段(`permissionMode` 等)

per-session MCP token(D1 ADR):
- spawn 时为新 codex session 在 `mcpSessionTokenMap.allocate(sid)` 拿一次性 token → envOverride `{ AGENT_DECK_MCP_TOKEN: <session-token> }` 注入 codex SDK 子进程
- codex CLI 通过 `bearer_token_env_var: 'AGENT_DECK_MCP_TOKEN'` 读 env var 拼 HTTP `Authorization: Bearer <token>` 头连 streamable HTTP MCP server
- 应用 HookServer 收到 Bearer token → 反查 `mcpSessionTokenMap.get(token)` → 命中返 caller `sessionId` 自动填入 tool handler `extra.authInfo.resolvedSid`(caller 无需手动传 `caller_session_id` arg)
- 全局 token fallback(外部 codex CLI 走 `process.env.AGENT_DECK_MCP_TOKEN` 全局值)只能读不能写(spawn / send / archive 等高危 tool deny external caller)

### recoverer cwd 启发式 fallback(兜底)

caller 取消归档继续给已收口 plan-driven session 发消息(撞 cwd 失效)/ 用户手动 `git worktree remove` 不走 archive_plan / 跨设备同步丢目录 → codex sdk-bridge.recoverer 启发式找仍存在的祖先目录当 cwd 兜底(worktree 路径取段之前部分 / 父目录 walk 不超过 home),找到 → emit info + 强制走 jsonl missing fallback 同款下游(CLI 历史失但应用层 events / file_changes / summaries 子表保留);找不到 → emit error 清晰告诉用户。算法详 `src/main/adapters/codex-cli/sdk-bridge/recoverer.ts`。
