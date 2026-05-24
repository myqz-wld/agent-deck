<!-- 由 resources/codex-config/CODEX_AGENTS.md 打包注入到 codex SDK 子进程加载链(`~/.codex/AGENTS.md`)末尾;维护说明详 resources/codex-config/README.md(若存在)与 resources/claude-config/README.md 同款。 -->

--- Agent Deck 应用环境约定（codex 视角，随应用打包注入到每个 codex SDK 会话）---

# 应用环境约定（codex 视角）

> 本文件是 **codex 视角** 的应用环境约定。**claude 视角**等价物在 `resources/claude-config/CLAUDE.md`(同应用打包同步注入 claude SDK system prompt 末尾)。两份 file 协议层语义对齐(Wire format / send_message / archive_plan / hand_off_session / shared-team 约束同款),只在**纯 codex 工具差异处**(`shell` vs `Bash` tool / `~/.codex/AGENTS.md` 加载点 / `sandboxMode` `approvalPolicy` 而非 claude 的 `--permission-mode` / 无 native EnterWorktree CLI 必须走 MCP tool)分别说明。
>
> **加载范围**：codex SDK 起 thread 时自动加载 `~/.codex/AGENTS.md`(本应用 build-time installer 把本文件内容同步到该路径)。codex 子进程 system prompt 末尾追加本文件内容,与 claude SDK `settingSources: ['user','project','local']` 自动加载 `~/.claude/CLAUDE.md` 是平行机制。

## 应用环境差异（Δ user CLAUDE.md）

### 协议覆盖：teammate 协作走 mcp tool

本应用环境(agent-deck) teammate 协作走 mcp tool(详 §Agent Deck Universal Team Backend 节)。teammate 通过 `send_message` 发消息 → universal-message-watcher → adapter.receiveTeammateMessage → adapter.sendMessage → codex SDK 把 message 喂给 receiver thread 自动注入 conversation flow(receiver codex 看到 user-role message 直接 act on it,无需主动 poll)。

### task 进度跟踪走 `mcp__agent-deck__task_*`(codex 端与 claude 端对称,无独立 task server)

本应用环境跑 plan / 多 Agent 协作 / 多步骤工作时,**task 进度跟踪必须走** `mcp__agent-deck__task_create` / `task_update` / `task_list` / `task_get` / `task_delete`(codex CLI 本身无内置原生 task 工具,所以不存在"替代"问题,直接用本组)。

**Why**(plan task-mcp-owner-session-id-rewrite-20260521 v023 + task-mcp-merge-into-agent-deck-mcp-20260521 合并):
- `mcp__agent-deck__task_*` 自动闭包当前 codex SDK session 的 `owner_session_id`(每条 task 必有 owner = 创建时的 caller session id,无 global task 概念)
- task 可见性 = 同 active team 反查:caller 自己 + 同 team active 成员的 task 全可见(task scope 由 sessions 表 reverse join `agent_deck_team_members` 算,task 表本身不存 team 字段)
- 写权限 = caller 与 task owner 共享 active team(含 caller==owner 自己改自己 task 特例);跨 team 写 reject
- task 状态对 teammate(claude / codex 任一 adapter)/ hand-off 后新 session 全可见,不丢进度
- hand_off_session 默认 `archive_caller=true` 时原子 `reassignOwner(caller→newSid)` 把 caller 拥有的所有 task 过继给新 session(plan §D3),配合 FK ON DELETE CASCADE 让 caller archive 不删 task
- codex SDK 走 streamable HTTP transport 连本应用 MCP server,本组工具与 `send_message` / `spawn_session` 等同款 transport / 同款 per-session token 鉴权(合并后 codex 与 claude 端对称都能用 task tools)

**How to apply**:
- 新建 task: `mcp__agent-deck__task_create({ subject, description?, status?, priority?, blocks?, blocked_by?, labels? })` → 返 `{ id, ownerSessionId, ... }`,owner 自动闭包(caller session id)
- 状态切换: `mcp__agent-deck__task_update({ task_id, status })`,枚举 `pending` / `active` / `completed` / `blocked` / `abandoned`(注意 `active` 替代 Claude Code 原生 `in_progress`)
- 列表查询: `mcp__agent-deck__task_list({ status_filter?, subject_filter?, limit?, offset? })` → 返 `{ total, hasMore, tasks }`(visible scope = caller + 同 active team active 成员,自动反查无需传 team_id;`hasMore: true` 表示 `tasks.length === limit` 可能还有,翻页传 `offset: prevOffset + tasks.length`)
- 单个查询: `mcp__agent-deck__task_get({ task_id })`(不限 team,跨 owner 可读)
- 删除: `mcp__agent-deck__task_delete({ task_id, force?: false })`,force=true 级联删 downstream(每个 child 也过同 team 写权限校验)

**例外**: 应用 settings `enableAgentDeckMcp: false` 关闭时本组工具(以及其他 agent-deck mcp 工具)整体不挂 → codex SDK session 没有 task 工具可用(codex CLI 本身无原生替代),plan / 多步骤工作进度跟踪只能落在 plan 文件 §当前进度 节 + 对话历史。本应用打包 SDK 会话 toggle ON 时挂上,挂上后**优先用 mcp__agent-deck__task_\***。

**Breaking 历史**: 5 个 task tool 从 `mcp__tasks__task_*` 改名 `mcp__agent-deck__task_*`(plan task-mcp-merge-into-agent-deck-mcp-20260521),task 物理位置合并入 agent-deck-mcp namespace + 删独立 `enableTaskManager` toggle(smart migration 自动 carry 老用户 ON 值到 `enableAgentDeckMcp`)。合并后 codex 与 claude 完全对称都能用 task tools(修前 codex 端 mcp_servers.tasks 没注入是 bug)。

### codex 无 native EnterWorktree / ExitWorktree CLI → 必须走 MCP

claude SDK 在 CLI binary 内置 `EnterWorktree` / `ExitWorktree` 工具(直接调用建/退 git worktree + 切 cwd)。**codex CLI 没有等价 builtin** — 想从 codex session 内创建 / 标记 / 清理 worktree,只能调本应用提供的 MCP tool:
- `mcp__agent-deck__enter_worktree({ plan_id, base_commit?, base_branch? })`:创建 worktree 目录 + 记录 cwd_release_marker。**不会改变 codex SDK session cwd**；后续 shell 命令必须显式 `git -C <worktree_path>` 或使用 worktree 绝对路径
- `mcp__agent-deck__exit_worktree({ action: "keep" | "remove", discard_changes?: false })`:清理 marker,按 action 保留或删除 worktree(同 claude 端 ExitWorktree 的归档前置语义,但不改变 codex shell 默认 cwd)
- 详 §Agent Deck Universal Team Backend §enter_worktree / exit_worktree 节

claude 视角同款 tool 也存在(MCP 通用),claude 端用 CLI builtin 作首选。codex 端**无 fallback**必须走 MCP。

### reviewer-claude 失败 → SKILL 内合规兜底分支（对称 claude 视角）

`deep-review` SKILL 内若 reviewer-claude teammate 失败（claude SDK 起不来 / OAuth 过期 / sandbox 拒 / timeout / claude jsonl 缺失 fresh-session abort），lead 走 `shell` 起外部 claude CLI（按 user 全局模板 `~/.claude/templates/reviewer-claude.sh.tmpl` 填）仍构成 Opus 4.7 vs gpt-5.5 异构对（详 SKILL.md §失败兜底 表）。通用 user CLAUDE.md §reviewer-codex 失败兜底「严禁同源化降级」一条对两路对称 enforce。

---

## Agent Deck Universal Team Backend

跨 adapter 协作通过 Agent Deck MCP 15 tool（10 现有：`mcp__agent-deck__spawn_session` / `send_message` / `list_sessions` / `get_session` / `shutdown_session` / `archive_plan` / `hand_off_session` / `enter_worktree` / `exit_worktree` / `shutdown_baton_teammates`；+ 5 task：`task_create` / `task_list` / `task_get` / `task_update` / `task_delete`）编排 + 管理结构化任务。teammate 调工具时走自己 codex SDK 会话的 `approvalPolicy` + `sandboxMode`,**lead 不插手 teammate 权限审批**(失败弹给真人走 teammate 自己 session 的 PendingTab)。

速查:`spawn_session` 起 SDK session;`send_message` 统一发消息 / reply;`list_sessions` / `get_session` 只读查会话;`shutdown_session` close lifecycle 不删数据;`archive_plan` 原子归档 plan;`hand_off_session` baton 接力;`enter_worktree` / `exit_worktree` 管 worktree;`shutdown_baton_teammates` 补跑 teammate cleanup。

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

`archive_plan` 在 plan 完成后**原子执行** user CLAUDE §Step 4「完成」5 步:ff merge worktree branch → `base_branch` / 更新 frontmatter (`status=completed` + `final_commit` + `completed_at`) / mv plan → `<main-repo>/plans/<plan_id>.md` / **如 plan 有 spike-reports/ → mv `<plan-artifact-dir>/spike-reports/` → `<main-repo>/plans/<plan_id>/spike-reports/`** / 同步 `<main-repo>/plans/INDEX.md` / `git add` + commit / `git worktree remove` + `git branch -D`。caller 调用前必须先 `exit_worktree(action: "keep")`(codex 端走 MCP,不是 claude builtin)。

**调用**:`mcp__agent-deck__archive_plan({ plan_id, worktree_path, base_branch?: <plan frontmatter.base_branch ?? "main">, plan_file_path?, changelog_id? })`(`base_branch` 默认值:schema 优先读 plan frontmatter.base_branch,缺失才 fallback "main")
**返回**:`{ archived_path, commit_hash, branch_deleted, worktree_removed, plans_index_action: 'created'|'appended'|'updated'|'unchanged', final_status, warnings: string[], spike_reports_archived: { src_path, dst_path } | null, archived: 'ok'|'failed'|'skipped', teammatesShutdown: { closed, failed, skipped } }`

**app-only 差异**:

- **预检短路**:plan status ≠ in_progress / worktree dirty / **caller session cwd 在 worktree 内** / detached HEAD 任一命中 → 立即返回 error,不做部分回滚(git 操作不可逆)。**codex 端 cwd 预检**走 sessionRepo.cwd + `cwd_release_marker` 字段(HIGH-C 修法 4 态分流),不直接读 process.cwd
- **lead 必须先 exit_worktree**:tool 内不能调 exit_worktree;cwd 在 worktree 内时 tool 直接 reject
- **自动归档 caller session**:plan 收口后默认归档 caller(baton 同款语义),返回 `archived` 三态字段;归档失败仅 warn 不阻塞 ok return
- **abandoned plan 不走本 tool**:tool 强制 `status=completed` 且入项目 git 归档;abandoned 走 user CLAUDE §Step 4 §中止 手工流程
- **changelog 引用归档** agent 自己写(tool 不做)
- **spike-reports/ 自动归档**:detect `<plan-artifact-dir>/spike-reports/` 存在(`<plan-artifact-dir>` = `<plan-file-dir>/<plan-id>/`,即 plan 文件父目录下的同名 artifacts 目录)→ mv 到 `<main-repo>/plans/<plan_id>/spike-reports/`(plan .md 同名子目录与 plan .md 平级,约定 plan .md 是主体 + 同名目录是 artifacts),spike-reports/ 子目录递归入 git 归档 commit。不存在 → skip 不报错(trivial plan 无 spike 是合法场景)。mv 失败(EXDEV 跨 fs / perm)→ warnings 落 hint「spike-reports archive failed: ... Manually run \`mkdir -p && mv && git add+commit --amend\`」+ 不阻塞 ok return。`spike_reports_archived` 字段告诉 caller 实际归档结果(null = skip / `{src_path, dst_path}` = 成功)
- **followup 20260515 (a)+(b)+(c)+(d) UX 完善**:
  - fallback 链 `<main-repo>/.claude/plans/` > `<main-repo>/plans/` > `~/.claude/plans/`(加中间档兜底本项目实际惯例)
  - `plan_file_path` 文件名 stem 必须 == `plan_id`(impl 层 reject 防 silent unlink)
  - INDEX 4 列 canonical `| 文件 | 状态 | 关联 changelog | 概要 |` + smart update existing 行(替换 status / changelog / description)
  - `changelog_id` optional string + csv(单值 `"122"` / 多值 `"121,122"`),拼成 markdown link 写入 INDEX 第 3 列;不传时 smart update 保留老 4 列 changelog 列 / 旧 2 列或新 append 用 `—` placeholder
  - `plans_index_action` 四态 enum 替代旧 boolean,让 caller 区分 INDEX 行真正发生的事情
  - `warnings` non-fatal warning 数组(如 `.claude/plans/<id>.md` 与 `plans/<id>.md` 同 id 双存覆盖警告 — 走 warn 而非 reject)
  - 7 phase post-ff-merge 失败专用 phaseHint 给具体 manual recovery 决策树(替代旧通用 hint)
- **mainRepo dirty precheck 精确化(plan deep-review-batch-a1-b-followup-r3-20260519 §不变量 5)**:旧版 mainRepo 任意 dirty 全场 fail-fast;新版仅 reject 三具体路径 `{archivedPath, indexPath, planFilePath}` 命中 dirty / staged / untracked / R rename / C copy(含 old/new path 任一命中)— 其他无关 dirty 文件降 warning + commit message 注脚(commit pathspec 隔离不吞)。precheck 失败时 hint 软引导 caller fix 撞 critical paths 后重 invoke archive_plan,**或** 走 §escape hatch: shutdown_baton_teammates 补跑 baton-cleanup phase 1(如 caller 必须手工归档场景)— 不硬技术阻断手工归档(user CLAUDE.md §Step 4 5 步手工归档仍是合法 fallback)

### escape hatch: shutdown_baton_teammates

`shutdown_baton_teammates` 让 caller 手工归档 plan 后**补跑** baton-cleanup phase 1(同 team 其他 active+dormant teammate 一并 close + `team_member.left_at` 软退出)。仅供 archive_plan 撞 precheck fail / 历史 dormant 残留清理使用。

**调用**:`mcp__agent-deck__shutdown_baton_teammates({ caller_session_id?, plan_id? })`
**返回**:`{ closed: string[], failed: Array<{sessionId,reason}>, skipped: null, planId: string | null }`

**典型场景**(plan deep-review-batch-a1-b-followup-r3-20260519 §D4 F1c):

archive_plan tool 撞 mainRepo dirty / cwd resilience guard 等 precheck fail → caller 走 user CLAUDE.md §Step 4 5 步手工归档绕过 archive_plan tool(commit + mv plan + git worktree remove + branch -D)→ runBatonCleanup phase 1 没被调到 → 同 team teammate(reviewer-claude / reviewer-codex 等)自然衰减成 dormant 但**没** closed,占内存 + SDK live query。本 tool 让 caller 显式补跑 phase 1。

**与 archive_plan 的边界**:

- archive_plan 是 plan 收口 tool(git ff-merge / mv plan / commit / git worktree remove)+ default baton-cleanup phase 1+2(plan hand-off-session-adopt-teammates-20260520 Phase 3 删 phase 1 opt-out 字段,archive_plan 不再支持 phase 1 跳过)
- `shutdown_baton_teammates` 是「补跑 phase 1」的独立 tool,**不**做任何 git/fs 归档操作;**不**调 phase 2 archive caller(caller 决定何时 archive;典型场景 caller 已手工归档完毕)

**错误契约**(plan §F1c R2 codex MED-4):

- caller 不在任何 team 是 lead(caller 是 teammate / 无 active membership / 所有 caller-lead 团队都已 archive)→ **error + hint**(**非** silent return success — escape hatch 是 caller 显式请求 cleanup,no-op 误导 caller 以为成功了)。hint 指向 IPC `TeamShutdownAllTeammates` handler 或 UI Team 面板「Shutdown all teammates」按钮(不要求 caller 是 lead)
- helper 自身抛错(agentDeckTeamRepo SQLite locked / sessionManager.close abort 等)→ error + console.warn,**不**像 archive_plan / hand_off_session 兜底 warn 不阻塞(本 tool 是 escape hatch,helper 失败就是补跑没成功,需让 caller 显式知道)

**deny external caller**(types.ts EXTERNAL_CALLER_ALLOWED.shutdown_baton_teammates = false):sessionManager.close 是写操作 + caller=lead 反查需要真实 caller_session_id,绝不允许 stdio external client 调用(避免被恶意 mcp client 利用清理任意 team session)。

### plan hand-off 自动化:hand_off_session

`hand_off_session` 起新 SDK session 接力 + 自动归档 caller。**双模式**:plan-driven 传 `plan_id`(读 plan frontmatter,要求 `status: in_progress` + 有 `worktree_path`,cold start prompt = `按 <plan-abs-path> 接力`,可附 `phase_label`);generic 不传 `plan_id`(不读 plan,cold start prompt = `args.prompt` 或默认「从上一个会话接力继续工作」)。

**调用**:`mcp__agent-deck__hand_off_session({ plan_id?, phase_label?, prompt?, cwd?, adapter?: "codex-cli", team_name?, codex_sandbox?, plan_file_path?, archive_caller?: true, adopt_teammates?: false })`
**返回**:`{ mode: 'plan'|'generic', planId, planFilePath, worktreePath, initialPrompt, sessionId, cwd, teamId, teamName, spawnPromptMessageId, archived, teammatesShutdown, ... }`

**app-only 差异**:

- **cwd resilience**:plan-driven 默认 `cwd = mainRepo`(fallback 链 `args.cwd > resolved.mainRepo > resolved.worktreePath`),让 sessionRepo.cwd 在 worktree 被 archive_plan 删后仍 valid;新 session 自己按 user CLAUDE §Step 3 cold-start 使用 `worktree_path` 推进,必要时才调 MCP `enter_worktree(plan_id)` 创建 / 标记 worktree(codex 端必走 MCP,不是 claude builtin,且不改变 codex shell 默认 cwd)。generic 默认 `cwd = caller cwd`
- **baton 不计 spawn_depth(仅 archive_caller=true 时)**:默认 `archive_caller=true` 路径内部 spawn 传 `batonMode: true` 跳 depth check + 写 `parentDepth`(lateral,不 +1)。理由:baton 单向交接(spawn 后立即 archive caller)任意时刻只 1 个 active session,**不构成 fork-bomb 风险**,N-phase 接力链不该撞默认 `mcpMaxSpawnDepth=3`。fan-out + spawn-rate guard 仍 enforce。**`archive_caller: false` 退化 normal spawn**:caller 不归档 = caller 与新 session 同时 active = 接近 spawn 用法,`resolveBatonRoleForSpawn` 返 `batonMode=false` 不跳 depth check(防止 caller 用 opt-out 路径绕过 spawn_depth 限制开 N-phase fork-bomb)
- **archive 默认 true,可 opt-out**(P5 Round 1 reviewer-codex M2 修法 — 文档与 schema 对齐):caller 无论 untracked / dirty / 已加入 team 都归档(default);typical baton 语义「任意时刻单 in-flight session」自然成立。**例外 opt-out**:caller 显式传 `archive_caller: false` 跳过归档(罕见场景:lead 起多个 hand-off 子任务并行做事自己仍想看 reviewer reply / 出 summary;debug 工具想起新 session 实测某 plan 但 caller 仍要观察)。`archive_caller: false` 时 ok return.archived === "skipped"
- **default 不加 team**:baton 单向交接不强加 lead/teammate 关系;显式 `team_name` 才启用通信
- **adopt_teammates 选 in 接管 caller 同 team 当 lead**(plan hand-off-session-adopt-teammates-20260520 Phase 4):default false 走纯 baton(原 teammate 与新 session 失去 shared active team,`send_message` 撞 no-shared-team)。**`adopt_teammates: true`** 让新 session 接管 caller 同 team 当 lead,原 teammate 与新 session 共享 active team 可继续 send_message 沟通。**N5 ≥1 lead 硬约束**:caller 在所有 team 都不是 lead → handler spawn 之前 fail-fast 返 error,不 spawn / 不 archive caller。**N2.c 互斥**(zod refine reject + handler 防御性硬约束 — adopt 路径自动过继 caller 自己 team,与显式额外 team 语义冲突)。**archived team / archived teammate filter**(Phase 7):caller 在 archived team 的 ghost membership(role 不论 lead / teammate)push failed reason='team-archived';archived teammate(`sessions.archived_at !== null`)进 failed reason='session-archived' + cold-start prompt 装配时已过滤(避免新 session 调 send_message 撞 findSharedActiveTeams 强制 archived 过滤)。Detail 见 ok return.adopted 字段:`{ preserved, failed, teamsTotal, teamsAdopted, firstTeamId } | null`(adopt_teammates: true 时 non-null;`failed.reason` 取值 `'caller-not-lead-in-team' / 'team-archived' / 'swap-lead-failed: ...' / 'swap-lead-error: ...' / 'session-missing' / 'lifecycle-closed' / 'session-archived'`)。
- **预检短路**:plan-driven 模式 plan 文件不存在 / status ≠ in_progress / frontmatter 缺 `worktree_path` / spawn 失败 → 立即返回 error
- **新 session 必须含 user CLAUDE「复杂 plan」节 cold-start protocol 5 步**:codex SDK 加载链是 `~/.codex/AGENTS.md`(本文件),**不**自动加载 user CLAUDE.md(claude 端走 `settingSources: ['user',...]` 自动加载,codex 端无对等机制)。本应用环境**已在 §plan cold-start protocol(codex 端) 节 inline 5 步**让 codex 收到 `按 <plan-abs-path> 接力` 字面提示后能正确执行;若该节缺失或被裁剪,caller 起 cold-start prompt 时必须显式把 5 步 inline 进 prompt
- **task 自动过继**(plan task-mcp-owner-session-id-rewrite-20260521 v023 §D3 + deep-review Round 1 F1/F3 修法): spawn 完成 + 新 sid 落 DB + adopt 完成后、archive caller 之前, 原子 `UPDATE tasks SET owner_session_id = newSid WHERE owner_session_id = oldSid` 把 caller 拥有的所有 task 过继给新 session(`reassignOwner` 不刷 `updated_at` 让 list 默认排序保持稳定)。**`archive_caller: false` 路径跳过过继**(F1):caller 仍 active 继续 own 自己 task,通过 `isCallerAuthorizedToWrite` caller==owner 特例继续可写;**不**像修前无条件过继让 caller 与新 sid 无 shared team(default 不加 team)时失去 task 写权限。失败仅 warn 不阻塞 ok return + 走 `LifecycleScheduler.historyRetentionDays` TTL GC best-effort 兜底;caller 通过 ok return `taskReassignment` 字段(`'ok'+count` / `'failed'+error` / `'skipped'+reason`)看到结果(F3)。配合 v023 ON DELETE CASCADE 让 caller archive 后被物理删时 task 已留新 session 名下不被 CASCADE 删
- **ShutdownAllTeammates 不调 reassignTaskOwner**(IPC `AgentDeckTeamShutdownAllTeammates` + hand_off baton-cleanup phase 1):与 hand_off caller→newSid 不对称。teammate 关闭后 task 仍在 teammate 名下,被 `LifecycleScheduler.historyRetentionDays` TTL GC 触发 `sessionRepo.delete` 时 CASCADE 删。**设计取舍**:teammate context 已死 task 本质无主,删干净是合理设计(配合 GC 主语义)。若产品需要"lead 接管 teammate 遗留 task"需另外加 `reassignOwner(teammateSid, leadSid)` 调用(目前未实现)。
- **典型主动触发(generic mode)**:当前 cwd 不适合手头任务(cwd 已失效 / 不属目标 repo / 用户明示换目录 / 跨 repo 任务) → 不要在当前 session 强行 `cd` / 跨目录绝对路径(codex shell tool 切 cwd 不持久跨 turn),用 generic mode 显式传新 `cwd` + 自包含 `prompt` 接力到正确目录
- **prompt 装不下完整 context 时**(必要信息务必传递完整,避免 hand-off 丢失大量上下文):caller 先把 context 落盘到 `/tmp/handoff-<id>.md`(临时文件不用清理),prompt 起手写「先 `shell: cat <abs-path>` 再按文件内指令推进」让新 session cold-start 第一步读全
- **想保留 caller 不归档** → 两个选项:① `hand_off_session({..., archive_caller: false})` 显式 opt-out(详上方 archive 默认 true 节);② `spawn_session(cwd:<目标>, prompt:<打包信息>)` 而非 `hand_off_session`(spawn 出新 session 但不切换接力身份,适合并行子任务)

### plan cold-start protocol(codex 端 5 步)

新 codex SDK session 收到 hand_off_session 注入的 cold-start prompt(典型字面:`按 <plan-abs-path> 接力(Phase: <phase_label>)`)时,**必做** 5 步:

1. `shell: cat <plan-abs-path>` 读 plan 全文(P5 Round 1 reviewer-claude INFO 修法:codex CLI 默认无 native Read tool,与 claude CLI 不同 — 跨会话第一次读「长期存在 + 其他会话动过的文件」务必走 `shell: cat` 走真 fs。本规约对 codex 端单方有效;claude 端有 Read tool 缓存陷阱另规)
2. 从 frontmatter 拿 `worktree_path` + `plan_id`。若 `worktree_path` 已存在(典型 hand_off_session 接力已有 plan worktree),**不要**调 `enter_worktree`(该 tool 只创建新 worktree,会拒绝复用既有 path);直接使用 worktree 绝对路径推进。若 plan 仍处在“新建 worktree”阶段且路径不存在,才调 `mcp__agent-deck__enter_worktree({ plan_id, base_commit: <frontmatter.base_commit> })` 创建并记录 marker(codex 无 native EnterWorktree CLI;`base_commit` 显式传 frontmatter 的 `base_commit` 避撞 stale base bug)
3. 自检:`shell: git -C <worktree_path> rev-parse HEAD` 与 `git -C <worktree_path> log --oneline -3`,确认 HEAD = frontmatter `base_commit` / `final_commit` 或之后
4. 按 plan **§下一会话第一步** 节直接动手:**不重新讨论已记录的 §设计决策**;**所有 shell / 文件路径显式指向 worktree**(`git -C <worktree_path>` 或 `<worktree_path>/...`),不要依赖 codex SDK cwd 已切换;plan 「§下一会话第一步」描述的「先 X 再 Y 再 Z」级别动作按字面执行
5. 进度变更 / §设计决策 / §不变量 修订必须先告诉用户征得确认(plan §Agent 自主 hand-off 授权 节列具体例外清单)

> claude 视角的对应 protocol 在 user CLAUDE.md §复杂 plan §Step 3 §选项 A;codex 端无 user CLAUDE.md 自动加载机制(claude 端走 `settingSources` 自动加载),本节是 codex 端等价物 inline。

### codex SDK 特有:per-session token / spawn options default

codex teammate spawn(`adapter: 'codex-cli'`)走 options-builder 默认 enforce 一组 spawn options(reviewer-* 必需):
- `sandboxMode: 'workspace-write'`(SDK 默认档;`approvalPolicy: 'never'` 配合不弹审批)
- `approvalPolicy: 'never'`(SDK 无 UI 弹审批会挂)
- `networkAccessEnabled: true`(reviewer-codex teammate 调 OpenAI API;cross-adapter pair 时 reviewer-claude 跑在 claude SDK 端不走本 default)
- `additionalDirectories: ['~/.claude', '~/.codex', '/tmp']`(reviewer 跨目录读 plan / claude config / codex config 文件 + cache 中间文件落 `/tmp`)
- 只有内部 createSession 调用方能覆盖完整 codex SDK options；MCP `spawn_session` 当前仅暴露 `codex_sandbox` / `permission_mode` 等白名单字段,**不**暴露任意 `additionalDirectories` / `networkAccessEnabled` override。需要读默认范围外文件时,走 deep-review SKILL auto cp 或把文件复制到 worktree/repo cwd / `~/.claude` / `~/.codex` / `/tmp` 后再传 scope

per-session MCP token(D1 ADR):
- spawn 时为新 codex session 在 `mcpSessionTokenMap.allocate(sid)` 拿一次性 token → envOverride `{ AGENT_DECK_MCP_TOKEN: <session-token> }` 注入 codex SDK 子进程
- codex CLI 通过 `bearer_token_env_var: 'AGENT_DECK_MCP_TOKEN'` 读 env var 拼 HTTP `Authorization: Bearer <token>` 头连 streamable HTTP MCP server
- 应用 HookServer 收到 Bearer token → 反查 `mcpSessionTokenMap.get(token)` → 命中返 caller `sessionId` 自动填入 tool handler `extra.authInfo.resolvedSid`(caller 无需手动传 `caller_session_id` arg)
- 全局 token fallback(外部 codex CLI 走 `process.env.AGENT_DECK_MCP_TOKEN` 全局值)只能读不能写(spawn / send / archive 等高危 tool deny external caller)

### recoverer cwd 启发式 fallback(兜底)

caller 取消归档继续给已收口 plan-driven session 发消息(撞 cwd 失效)/ 用户手动 `git worktree remove` 不走 archive_plan / 跨设备同步丢目录 → codex sdk-bridge.recoverer 启发式找仍存在的祖先目录当 cwd 兜底(worktree 路径取段之前部分 / 父目录 walk 不超过 home),找到 → emit info + 强制走 jsonl missing fallback 同款下游(CLI 历史失但应用层 events / file_changes / summaries 子表保留);找不到 → emit error 清晰告诉用户。算法详 `src/main/adapters/codex-cli/sdk-bridge/recoverer.ts`。
