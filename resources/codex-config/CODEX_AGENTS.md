<!-- 由 resources/codex-config/CODEX_AGENTS.md 打包注入到 codex SDK 子进程加载链(`~/.codex/AGENTS.md`)末尾;维护说明详 resources/README.md。 -->

--- Agent Deck 应用环境约定（codex 视角，随应用打包注入到每个 codex SDK 会话）---

# 应用环境约定（codex 视角）

## 优先级声明（必读）

本文件是 agent-deck 应用环境的 baseline 约定（codex 视角，注入 `~/.codex/AGENTS.md` 内由 Agent Deck installer marker 包裹的段）。**优先级链**:
- codex SDK 内置安全约束（sandbox / approval policy / system rules）**始终最高优先级**,本文件不替代
- **developer message / per-turn user prompt 中的指令优先级高于本文件 baseline**;与本文件冲突时**以 caller 当下指令为准**
- 如 `~/.codex/AGENTS.md` 内有 marker 之外的用户自加段,**该用户段与本文件 baseline 平等加载到 codex system prompt**(同 baseline 层级,无强优先级关系;与本文件冲突时 caller / user 必须自行选边或重审约定一致性 — 不依赖默认 fallback)
- 本文件提供 agent-deck 应用专属补充能力（mcp tool / plugin SKILL / cold-start 协议等）,不替换 user 通用约定

> **注:** **claude 视角等价 `CLAUDE.md` 因 claude SDK 加载机制不同(`settingSources: ['user',...]` 自动加载 user CLAUDE.md 作 baseline,有 user 通用约定全局加载机制)措辞不同是 adapter 差异不是 SSOT drift,维护时不要强行对齐两端**。

> 本文件是 **codex 视角** 的应用环境约定。**claude 视角**等价物在 `resources/claude-config/CLAUDE.md`(同应用打包同步注入 claude SDK system prompt 末尾)。两份 file 协议层语义对齐(Wire format / send_message / archive_plan / hand_off_session / shared-team 约束同款),只在**纯 codex 工具差异处**(`shell` vs `Bash` tool / `~/.codex/AGENTS.md` 加载点 / `sandboxMode` `approvalPolicy` 而非 claude 的 `--permission-mode` / 无 native EnterWorktree CLI 必须走 MCP tool)分别说明。
>
> **加载范围**：codex SDK 起 thread 时自动加载 `~/.codex/AGENTS.md`(本应用 build-time installer 把本文件内容同步到该路径)。codex 子进程 system prompt 末尾追加本文件内容,与 claude SDK `settingSources: ['user','project','local']` 自动加载 `~/.claude/CLAUDE.md` 是平行机制。
>
> **self-contained 范围**:本文件包含 Codex 端 Agent Deck 协议 / plan cold-start / prompt 资产维护约定;弱相关通用方法论不放入应用环境约定。

## 应用环境特有能力（不依赖 user CLAUDE.md）

### 协议覆盖：teammate 协作走 mcp tool

本应用环境(agent-deck) teammate 协作走 mcp tool(详 §Agent Deck Universal Team Backend 节)。teammate 通过 `send_message` 发消息 → universal-message-watcher → adapter.receiveTeammateMessage → adapter.sendMessage → codex SDK 把 message 喂给 receiver thread 自动注入 conversation flow(receiver codex 看到 user-role message 直接 act on it,无需主动 poll)。

### codex turn boundary：等 teammate reply 必须结束 turn

Codex SDK 是 turn-based，不支持 claude SDK 的 stream input turn 内打断。Codex lead 调 `spawn_session` / `send_message` 后等待 reviewer / teammate reply 时，必须记录 `spawnPromptMessageId` 或 `messageId`、告诉 user 已派出任务，然后结束当前 turn；不要用 `sleep` / `get_session` 循环在同一 turn 等。下一条 wire-prefixed teammate reply 会作为下一轮 user input 注入，届时提取 `[msg <id>][sid <senderSid>]` 继续裁决。

只在 user 下一轮询问状态、或达到 SKILL 明确的卡住阈值时，才查 `get_session.lastEventAt` 并按 SKILL 走 nudge / shutdown / 重 spawn。simple-review / deep-review / 反驳轮 / Round 2 fix 全部遵守这个 turn boundary。

### task 进度跟踪走 `mcp__agent-deck__task_*`(codex 端与 claude 端对称,无独立 task server)

本应用环境跑 plan / 多 Agent 协作 / 多步骤工作时,**task 进度跟踪必须走** `mcp__agent-deck__task_create` / `task_update` / `task_list` / `task_get` / `task_delete`(codex CLI 本身无内置原生 task 工具,所以不存在"替代"问题,直接用本组)。

**Why**:
- task 必有归属 session（创建时自动绑当前 codex SDK caller，不存在「无归属 task」）— 归属 session row 被历史保留期 GC 或显式物理删除时，DB FK ON DELETE CASCADE 自动删 owner task（**注意**：`closed` / 归档标记 仅打 lifecycle 标记不删 row 不触发 CASCADE），无 backlog 累积
- task 可绑 team 也可不绑 — 绑了 = team 共享（同 team teammate 可见可写），没绑 = 私人（仅 owner 可见可写），类比群聊 vs 私聊。team 之间严格隔离避免 lead 跨 team 时 task 串流
- **权限**按 teamId 决定：team-bound → caller 必须是该 team active member 才能 read/write；personal → 仅 owner 可见可写（不开放同 team 共享，避免 lead 私人 task 被 teammate 偷看 / 偷改）
- **task_get 严格 team-scoped 不再「跨 team 可读」**:in-process lead 跨 team 看 teammate task / external mcp client 凭已知 taskId 查 task 两类 use case 都被推翻 — task_get 走与 task_update/delete 同款 deny external 对称语义。lead 想看跨 team teammate task 应走「让 lead 加入对方 team 作为 active member」再用 `task_list({ teamIdFilter })` 查
- **personal task 是 first-class**:用户不在任何 team 时仍能用 task(典型场景:lead 起 reviewer pair 不必加 team 也想用 task 跟踪)。不传 `teamId` = personal default,与 caller 是否在 team 无关
- task 状态对 teammate(claude / codex 任一 adapter)/ hand-off 后新 session 全可见,不丢进度
- `hand_off_session` baton 时按 `teamTaskPolicy` 三态处理 task(详 §handOff 节)
- codex SDK 走 streamable HTTP transport 连本应用 MCP server,本组工具与 `send_message` / `spawn_session` 等同款 transport / 同款 per-session token 鉴权(codex 与 claude 端对称都能用 task tools)

**How to apply**:
- **新建 personal task** (default): `mcp__agent-deck__task_create({ subject, description?, status?, priority?, blocks?, blockedBy?, labels? })` → owner_session_id 自动闭包当前 caller, teamId=NULL
- **新建 team-bound task** (caller 必在该 active team): `mcp__agent-deck__task_create({ subject, teamId: <team-uuid>, ... })` — 不在该 team 是 active member 时 reject
- 状态切换: `mcp__agent-deck__task_update({ taskId, status })`, 枚举 `pending` / `active` / `completed` / `blocked` / `abandoned`(注意 `active` 替代 Claude Code 原生 `in_progress`)。写权限按 teamId 判定;跨 team 写 reject
- 列表查询:
  - 默认 `mcp__agent-deck__task_list()` → 返 `{ total, hasMore, tasks }`,visible scope = caller 可见 scope(自己 personal ∪ 所有 active team 的 team task;`hasMore: true` 表示 `tasks.length === limit` 可能还有,翻页传 `offset: prevOffset + tasks.length`)
  - `task_list({ teamIdFilter: <team-uuid> })` → 该 team 绑定的 task(caller 必在该 team active member)
  - `task_list({ teamIdFilter: 'null-personal' })` → caller 自己的 personal task(字面量,与传 team-uuid 区分语义)
- 单个查询: `mcp__agent-deck__task_get({ taskId })` — 严格 team-scoped read + deny external caller
- 删除: `mcp__agent-deck__task_delete({ taskId, force?: false })`, force=true 级联删 downstream(每个 child 都过同 team 写权限校验)

**例外**: 应用 settings `enableAgentDeckMcp: false` 关闭时本组工具(以及其他 agent-deck mcp 工具)整体不挂 → codex SDK session 没有 task 工具可用(codex CLI 本身无原生替代),plan / 多步骤工作进度跟踪只能落在 plan 文件 §当前进度 节 + 对话历史。本应用打包 SDK 会话 toggle ON 时挂上,挂上后**优先用 mcp__agent-deck__task_\***。

### codex 无 native EnterWorktree / ExitWorktree CLI → 必须走 MCP

claude SDK 在 CLI binary 内置 `EnterWorktree` / `ExitWorktree` 工具（直接调用建/退 git worktree + 切 cwd）。**codex CLI 没有等价 builtin** — 想从 codex session 内创建 / 标记 / 清理 worktree，只能调本应用提供的 MCP tool：
- `mcp__agent-deck__enter_worktree({ planId, baseCommit?, baseBranch? })`：创建 worktree 目录 + 记录 cwd 释放标记（让 archive_plan 4 态预检 case b 放过 codex caller）。**不会改变 codex SDK session cwd**（codex SDK session cwd 在 spawn 时已固定，后续 shell 命令必须显式 `git -C <worktreePath>` 或用 worktree 绝对路径）
- `mcp__agent-deck__exit_worktree({ action: "keep" | "remove", discardChanges?: false })`：清理 marker，按 action 保留或删除 worktree（同 claude 端 ExitWorktree 的归档前置语义，但不改变 codex shell 默认 cwd）
- 详 §Agent Deck Universal Team Backend §enter_worktree / exit_worktree 节

claude 视角同款 tool 也存在（MCP 通用），claude 端首选 CLI builtin。codex 端**无 fallback**必须走 MCP。

### reviewer-claude 失败 → SKILL 内合规兜底分支（对称 claude 视角）

`simple-review` / `deep-review` SKILL 内若 reviewer-claude teammate 失败（claude SDK 起不来 / OAuth 过期 / sandbox 拒 / timeout / claude jsonl 缺失 fresh-session abort），lead `shutdown_session` 掉失败的 reviewer-claude → `spawn_session({adapter:'claude-code', agentName:'reviewer-claude', ...})` 重 spawn 一个，与未动的 reviewer-codex teammate 仍构成 Claude adapter + Codex adapter 异构对（详 SKILL.md §失败兜底 表）。**严禁**自动降级到同源双 Codex（破坏异构对抗原则）— claude / codex 两路 reviewer 失败兜底对称 enforce。

---

## 提示词资产维护

**改长生命周期 prompt 资产前必走本节**——即 `resources/codex-config/CODEX_AGENTS.md`(本文件)/ `resources/claude-config/CLAUDE.md` / `agent-deck-plugin/agents/reviewer-codex.md` / `agent-deck-plugin/skills/*/SKILL.md`(codex 端) / 注入 codex SDK 的 mcp tool description;维护本仓库时还包括根 `README.md` / `CLAUDE.md` / `AGENTS.md` / `resources/README.md`。**不适用**:src/ 业务代码注释 / 一次性 prompt(spawn 临时拼的 reviewer / cold-start prompt)/ 历史快照(ref/ 下写定不改)。

**核心原则——受众优先**:这些资产是写给「读它的 agent」看的,不是写给维护者看的。每个单元(章节 / 工具描述)第一句先答**做什么 + 何时用**,让没读过代码的 agent 一眼知道何时调;调用契约 / 参数其次;内部不变量(§ref / 闭包机制 / 状态机细节)移到末尾或直接删。issue 工具长期没人调,就是因为描述开头全是 `§不变量` 而不是 trigger。

### 5 条硬约束

1. **去重**:同款规则只在一处写全,其余 cross-ref 不复制;`shell: grep '<关键短语>' <资产>` 命中 ≥ 2 处即合并。**例外**:reviewer-codex.md §核心纪律 / SKILL inline 纪律是有意独立注入 codex SDK 的 self-contained 副本,不抽 SSOT。
2. **只写当前事实**:禁「兼容|FUTURE|TODO|未来|向后|deprecated|过渡期|后续会加|老版本|旧结构|历史升级|目录建立之前|迁移」这类旧态 / 预测 / 过渡表述;废弃的功能 / 字段直接删,不留 deprecated 注释。不要保留“旧路径仍支持 / 后续迁移 / 目录建立之前”这类兼容逻辑;旧行为若仍影响当前 agent 动作,改写成当前可执行规则,不讲历史。
3. **可执行 > 描述**:写「做 X / 违反直接拒绝」,不写「建议 / 最好 / 可以 / 应该考虑」;模糊副词(通常 / 一般 / 大概)必须配「但 X 时例外」的具体边界。
4. **少兜底**:只留**会改变 caller 下一步动作**的失败处理(如「失败走 Y」)。纯防御性实现细节(race / TOCTOU / EXDEV / "仅 warn 不阻塞" / 穷举 error reason)属代码注释,不进 agent 读的描述。
5. **示例克制**:一条规则一两个最具代表性的示例够了;同款重复示例("如 X / Y / Z" 里 Y/Z 与 X 雷同)删掉。

### 修改前自检(codex 端用 `shell: grep`,命中即按对应约束处理,全过再 commit)

1. **去重**:`shell: grep '<关键短语>' <file>` ≥ 2 → 合并(reviewer / SKILL inline 副本除外)
2. **当前事实**:`shell: grep -nE '兼容|FUTURE|TODO|未来|向后|deprecated|过渡期|后续会加|老版本|旧结构|历史升级|目录建立之前|迁移' <file>` ≥ 1 → 删(meta 引用 / 行为锚点除外)
3. **可执行**:`shell: grep -nE '建议|应该考虑|最好|可以(用|走|考虑)|大概率?|通常|一般' <file>` → 改成可执行动作或配具体边界
4. **首句 trigger + 少兜底**:通读每节 / 每个工具描述首句——是否先答「做什么 + 何时用」?防御性兜底是否塞进了描述?无 trigger 则补,防御细节则删回代码注释
5. **示例**:`shell: grep -nE '如[:：]|例如|比如' <file>` 命中后看示例数 ≥ 3 → 删雷同的

grep 工具不可用 / 假阳性 → 降级人工 review,不阻断 commit,commit message 注明「跳过自检 §N,理由」。

---

## Agent Deck Universal Team Backend

跨 adapter 协作通过 Agent Deck MCP 18 tool（10 个会话/plan/worktree：`mcp__agent-deck__spawn_session` / `send_message` / `list_sessions` / `get_session` / `shutdown_session` / `archive_plan` / `hand_off_session` / `enter_worktree` / `exit_worktree` / `shutdown_baton_teammates`；5 个 task：`task_create` / `task_list` / `task_get` / `task_update` / `task_delete`；3 个 issue：`report_issue` / `append_issue_context` / `update_issue_status`）编排会话、管理结构化任务并上报 issue。teammate 调工具时走自己 codex SDK 会话的 `approvalPolicy` + `sandboxMode`,**lead 不插手 teammate 权限审批**(失败弹给真人走 teammate 自己 session 的 PendingTab)。

速查:`spawn_session` 起 SDK session;`send_message` 统一发消息 / reply;`list_sessions` / `get_session` 只读查会话;`shutdown_session` close lifecycle 不删数据;`archive_plan` 原子归档 plan;`hand_off_session` baton 接力;`enter_worktree` / `exit_worktree` 管 worktree;`shutdown_baton_teammates` 补跑 teammate cleanup。

### 三个核心约定(lead 角度)

1. **spawn 首轮锚点**:`spawn_session` 返回 `spawnPromptMessageId: string | null`(仅当传 `teamName` 且 caller 在 sessions 表时非空),是首轮 prompt 在 messages 表的 placeholder id。teammate first turn 完成后调 `send_message({replyToMessageId: spawnPromptMessageId, ...})` 回复,reply 自动注入 lead conversation。lead 不需主动 poll —— 看到 user-role wire-prefixed message 即知 reply 到了
2. **后续轮次锚点**:`send_message` 返回 `{ sessionId, teamId, messageId, replyToMessageId, sentAt, queued: true }`。caller 用 `messageId` 在 DB 查 reply chain(如有审计需求);正常对话不需要 — receiver 收到 message 后会**自动通过 wire prefix `[msg <id>][sid <senderSid>]`** 提到 caller 的 messageId 当 `replyToMessageId` 调 send_message reply 回来。`replyToMessageId` 仅当 caller 调 send 时显式传入 `replyToMessageId` 才有值,开新话题(首条 message / 不挂 reply chain)时为 `null`
3. **shutdown 不删数据**:`shutdown_session` 只标 lifecycle='closed' + abort SDK live query;events / file_changes / summaries / messages 子表保留,lead 在裁决报告里仍可引用。team 成员关系软退出(行不删,archive 时归档面板仍可看 member 历史);spawn-link 父子关系全保留(list_sessions(spawnedByFilter) 跨 lifecycle 全见,跨会话救火依赖此)

> **dormant ≠ 丢 mental model**:lifecycle scheduler 转 dormant 只 abort codex SDK live query + 清 in-process `codexBySession` Map,**不删 thread jsonl**(codex 把 thread 历史持久化到 `~/.codex/sessions/<thread-id>.jsonl`);下一次 `send_message` 自动通过 `codex.resumeThread(threadId, options)` 复原对话历史。**唯一例外**:thread jsonl 缺失(用户手动删 `~/.codex/sessions/` / 应用重装 / 跨设备同步未带)走 hard fail fallback → teammate 触发 `⚠ FRESH SESSION` warn 必须重 spawn。
>
> 实操:复用直接 `send_message`;彻底不再用才 `shutdown_session`。

### send_message 一统消息发送

最小调用（普通 / reply 都用同一 tool，reply 加 `replyToMessageId` 链接 DB 对话链）：

```ts
mcp__agent-deck__send_message({ sessionId, teamId, text, replyToMessageId?, callerSessionId? })
// return: { sessionId, teamId, messageId, replyToMessageId, sentAt, queued: true }
```

字段速查：

| 字段 | 必传 | 含义 |
|---|---|---|
| `sessionId` | ✓ | target receiver session id |
| `teamId` | caller/target 共享多 team 时必传 | 共享单 team 自动 resolve；零共享 team 且省略则走 teamless DM |
| `text` | ✓ | message body |
| `replyToMessageId` | optional | 从收到的 wire prefix `[msg <id>]` 提取链入 reply chain |
| `callerSessionId` | codex teammate 走 MCP HTTP transport 时由 per-session token 自动反查填入 | external transport 必传 |

**收消息**：caller 调 send_message → universal-message-watcher 构造含 wire prefix `[from <name> @ <adapter>][msg <id>][sid <senderSid>]` 的 wireBody → receiver adapter 把 wireBody 喂给 receiver codex SDK thread → receiver codex 看到 user-role message 直接处理（lead 不需主动 poll，看到 wire-prefixed user message 即知 reply 到了）。

### 跨会话救火:list_sessions(spawnedByFilter)

lead context 重置 / 重启后捡 stranded reviewer:`list_sessions(spawnedByFilter:'<old_lead_sid>', statusFilter:'active')` 拉自己以前 spawn 的 active reviewer;按 sessionId 调 `send_message` 发新 prompt(receiver reply 通过 wire prefix `[msg <id>][sid <senderSid>]` 自动挂 reply chain 注入 lead conversation,与 §三个核心约定 §2 后续轮次锚点同款);收尾走 `shutdown_session`。

> ℹ️ **shared-team 与 teamless DM**(plan teamless-dm-20260601 起放宽):`send_message` 不再强制 caller 与 target 共享 active team。
> - **有 shared active team**:消息 team-scoped(行为不变;多 team 共享时仍需 `teamId` 去重)。
> - **无 shared active team 且未显式传 teamId**:自动降级 **teamless DM**(teamId=null),消息仍入 messages 表 + 注入 receiver SDK conversation,只是不进 team 聚合面板。
> - **显式传了不共享的 teamId**:仍 reject(`team-not-shared`,不静默降级)。
> - **archived caller / target**:teamless 路径显式 reject(不入队)。
>
> 对「跨会话救火」的实际影响:
> - **同 caller session(context 重置 / compaction)**:sessionId 不变 → 成员关系不变 → 直接 `list_sessions(spawnedByFilter)` 捡回来 + `send_message` 即可(team-scoped)。
> - **真换了 caller session**(应用重启 / 用户手动新开 / hand_off_session 默认不携 team 起新 session):新 caller 不在原 team 内 → `send_message` 现在**会以 teamless DM 投递成功**(不再 hard reject)。若只是想继续给 reviewer 发 prompt,teamless DM 即可用。但**需要保留 reviewer 跨轮 mental model / 多 team 正确归属**时,必须先回到 team:
>   1. 调 `spawn_session({adapter:'codex-cli', teamName:<old-team-name>, ...})` 重起一对 reviewer(旧的走 `shutdown_session` 收尾,避免 ghost)
>   2. 通过 UI 手动把新 caller 加入旧 team(应用 → Team 面板 → Add Member)
>   3. `hand_off_session` 起新 session 时显式传 `teamName:<old-team-name>` 让新 session 直接落入 team(仅当 plan 接力同 team 场景;baton 单向交接默认场景不加 team)
> - 需要保留 reviewer 跨轮 mental model → 走选项 2/3;接受重跑 reviewer → 走选项 1;只需单发消息不在意 team 归属 → 直接 teamless DM

### Wire format / regex / DB invariant

teammate 端协议约束(`[from <name> @ <adapter>][msg <id>][sid <senderSid>]\n` 三段 wire prefix / regex 提 messageId + senderSessionId / 用 send_message 回 / DB messages.body 不含 wire prefix 的 invariant)已强约束在 reviewer-{claude,codex}.md「核心纪律」节,**lead 不需关心**这些细节。

**wire format id invariant**:`messageId` 由 `crypto.randomUUID()` 生成(v4 UUID);`senderSessionId` 是 SDK / CLI 分配的 session id(codex 为 v7 thread id,非 v4)。两者均为 lowercase hex + hyphen 36 字符,regex `/\[msg ([0-9a-f-]+)\]\[sid ([0-9a-f-]+)\]/` 与该 charset 严格对齐,不得收紧为 version-specific UUID regex。

### NO MSG ANCHOR 退化路径(reviewer 端 fallback)

reviewer agent 收到的 user message 顶部如果没找到 `[msg <id>][sid <senderSid>]` 双锚点 wire prefix(典型:lead context 重置后用裸文本 ping / 第三方 dispatch 路径丢前缀),按下面 fallback 处理:

1. reply 顶部硬性输出 `⚠ NO MSG ANCHOR — prompt 顶部没找到 [msg <id>][sid <senderSessionId>] wire prefix,本 reply 没法挂 replyToMessageId 进 lead 对话链;请 lead 通过 send_message 重新发本轮 prompt 提供 anchor`
2. **退化路径**:仍要交付 finding / codex 输出(不 abort)。`sessionId` 反查:调 `mcp__agent-deck__list_sessions({statusFilter: 'active'})`(不 filter adapter — lead 可能是 claude-code / codex-cli 任一) → 按以下顺序定位 lead:① displayName 含 "Lead-" 前缀 / ② displayName 非 reviewer-* 标识 / ③ team 内排除自己 sessionId 后唯一 active;3 条都失败走第 4 步终极兜底。`teamId` 反查:调 `list_sessions` 看自己 session 的 `teams[]` 字段(与 lead 共享的 teamId)
3. **副作用警告**:reply 不挂 `replyToMessageId` 失去对话链锚点,DB / SessionDetail 看不出 reply 链关系;NO MSG ANCHOR 是**降级体验**,触发后 lead 应优先 shutdown + 重 spawn / 重发带 anchor 的 prompt 而非长期靠这个路径
4. **list_sessions 反查 lead 也失败**(多对 lead+teammate 同时跑歧义 / API 错):直接把 finding / codex 输出落本 codex SDK session 的 assistant output(不调任何 mcp tool),lead 切到本 reviewer 的 SessionDetail UI 仍可看到

### enter_worktree / exit_worktree(codex 端必走 MCP)

codex SDK session 内进 / 退 git worktree 必须通过本应用 MCP tool(codex CLI 无 native EnterWorktree / ExitWorktree builtin)。

**调用**:`mcp__agent-deck__enter_worktree({ planId, worktreePath?, baseCommit?, baseBranch?, planFilePath? })`
- `planId`:同 plan frontmatter `plan_id`(frontmatter 字段名是 snake_case),worktree 目录名 = `<main-repo>/.claude/worktrees/<plan-id-value>`,branch 名 = `worktree-<plan-id-value>`(schema 用 `baseCommit` / `baseBranch` 两字段)
- `baseCommit`(optional):caller 显式 commit hash / ref(最高优先级)
- `baseBranch`(optional):caller 显式 branch 名
- `worktreePath`(optional):override 默认 worktree 目录路径
- `planFilePath`(optional):override plan 文件路径
- **base 优先级链** 5 态:(1) `args.baseCommit` → `'arg-base-commit'` (2) `args.baseBranch` → `'arg-base-branch'` (3) plan frontmatter `base_commit` → `'frontmatter-base-commit'` (4) plan frontmatter `base_branch` → `'frontmatter-base-branch'` (5) main repo HEAD → `'head'`。**避开 EnterWorktree CLI stale base bug**(claude 端 builtin v2.1.112 默认用 `origin/<default>` 落后本地 HEAD;MCP impl 走 HEAD 不撞此坑)
- 副作用：创建 worktree 目录 + 新 branch + 设 cwd 释放标记（让 archive_plan 4 态预检 case b 放过 codex caller）。**不会改变 codex SDK session cwd**（codex 端 cwd 在 spawn 时已固定，后续 shell tool 必须用 `git -C <worktree>` 或 worktree 绝对路径）
- 返回:`{ worktreePath: string, branchName: string, baseCommit: string, baseSource: 'arg-base-commit' | 'arg-base-branch' | 'frontmatter-base-commit' | 'frontmatter-base-branch' | 'head', markerSet: boolean }`

**调用**:`mcp__agent-deck__exit_worktree({ action: "keep" | "remove", worktreePath?, discardChanges?: false })`
- `keep`:仅 clearCwdReleaseMarker(让 archive_plan 4 态预检走 marker null 路径),保留 worktree 目录 + branch(常用 — 准备 archive_plan 前的标准操作 since archive_plan 自己也清 marker)
- `remove`:同 keep + `git worktree remove` + `git branch -d/-D`(默认 `-d` 拒删未合并 commit;`discardChanges: true` 切 `-D` 强制删 + 同时跳过 dirty 预检)
- `worktreePath`(optional):默认省略让 impl 自动从 cwd 释放标记反查;仅当 caller 已知 worktree path 但 marker 丢失 (session restart / 跨进程接力等) 时显式传
- 返回:`{ worktreePath, action, branchDeleted: boolean, worktreeRemoved: boolean, markerCleared: boolean }`

### plan hand-off 自动化:archive_plan

plan 完成后一行原子收口,替代下方 §手工归档 fallback 5 步:ff-merge worktree branch 回 `base_branch` → 改 frontmatter(status=completed + final_commit + completed_at)→ mv plan 到 `<main-repo>/ref/plans/`(有 spike-reports/ 一并归档)→ 同步 INDEX → commit → 删 worktree + branch。**调用前先 `exit_worktree(action: "keep")`** 把 cwd 切出 worktree(codex 走 MCP,不是 claude builtin)。

**调用**:`mcp__agent-deck__archive_plan({ planId, worktreePath, baseBranch?, planFilePath?, changelogId? })`
- `baseBranch` 不传默认读 plan frontmatter.base_branch,缺失才 fallback "main"
- `changelogId` 关联已有变更记录编号(`"122"` 或 `"121,122"`),写进 plan INDEX 链接列;变更记录文件的组织规则不属于 archive_plan
- `planFilePath` 省略则按 `.claude/plans/` > `ref/plans/` > `~/.claude/plans/` 找;传了则文件名 stem 必须 == planId

**返回**:`{ archivedPath, commitHash, branchDeleted, worktreeRemoved, plansIndexAction, finalStatus, warnings, spikeReportsArchived, archived, teammatesShutdown }`

**要点**:
- **预检失败立即返 error 不回滚**(git 不可逆):plan status ≠ in_progress / worktree dirty / cwd 还在 worktree 内 / detached HEAD。codex cwd 预检走 session 记录的 cwd + cwd 释放标记,不读进程 cwd。dirty 只卡 plan 相关路径,无关 dirty 放行
- **默认归档 caller + 关掉同 team teammate**(baton 语义)
- **abandoned plan 不走本 tool**(强制 completed)→ 走下方 §手工归档 fallback §abandoned 中止
- **变更记录内容由当前项目规则生成**(tool 只更新 plan INDEX 链接)
- 预检失败但你已手工归档 → 用 §escape hatch shutdown_baton_teammates 补关 teammate

### 手工归档 fallback（跨 adapter 通用；archive_plan 不可用时）

archive_plan 撞 precheck fail / abandoned plan 时手工归档。codex 端用 `shell` 跑 git + `apply_patch` 改 frontmatter(无 native EnterWorktree/ExitWorktree,worktree 进退走 MCP)。

**completed 收尾 5 步**（步骤 1/2/3/5 同一事务,任一失败整片 abort;step 4 是变更记录关联）:
1. `exit_worktree(action: "keep")` 切出 worktree
2. ff-merge 回 frontmatter `base_branch`（不是无脑 main）:`git -C <main-repo> checkout <base-branch>` + `git -C <main-repo> merge --ff-only worktree-<plan-id>`
3. frontmatter 置 status=completed + final_commit + completed_at → mv plan 到 `<main-repo>/ref/plans/<plan-id>.md`（有 spike-reports/ 一并 mv）→ 同步 INDEX → `git add` + commit
4. 按当前项目规则补变更记录;若有编号,在 plan INDEX 关联列写入该编号（不抄全 plan）
5. `git worktree remove <worktreePath>` + `git branch -D worktree-<plan-id>`;**plan 关联 team 有 teammate** 则收尾后调 §escape hatch shutdown_baton_teammates 补关（无 team 跳过）

**abandoned 中止 3 步**（不入 git 归档）:frontmatter 置 status=abandoned + 理由 → `exit_worktree(action: "keep")` → `git worktree remove --force <worktreePath>` + `git branch -D worktree-<plan-id>`

> claude 视角等价 5 步 / 3 步在 `resources/claude-config/CLAUDE.md` §复杂 plan：Agent Deck baseline 最小协议 §完成 / 中止;两端独立 SSOT,codex 端 inline 是因 codex 无 `~/.claude/CLAUDE.md` 自动加载机制。

### escape hatch: shutdown_baton_teammates

手工归档 plan(绕过 archive_plan tool)后,用它补关同 team 的 reviewer teammate——否则它们衰减成 dormant 但没 closed,白占内存。archive_plan 正常跑时已含这步,不必再调。

**调用**:`mcp__agent-deck__shutdown_baton_teammates({ planId? })`
**返回**:`{ closed, failed, skipped: null, planId }`

- 只关 teammate,**不**做 git/fs 归档、**不**归档 caller 自己
- caller 在任何 team 都不是 lead → 返回 error(不是静默成功),按 hint 走 UI Team 面板
- deny external caller

### plan hand-off 自动化:hand_off_session

起新 SDK session 接力当前工作 + 默认归档 caller(单向 baton)。**两种模式**:传 `planId` = plan-driven(读 frontmatter,要求 status=in_progress + 有 worktree_path,cold-start prompt 自动 = `按 <plan-abs-path> 接力`);不传 = generic(cold-start prompt = 你传的 `prompt`)。

**调用**:`mcp__agent-deck__hand_off_session({ planId?, phaseLabel?, prompt?, cwd?, adapter?: 'claude-code' | 'codex-cli', teamName?, codexSandbox?, planFilePath?, archiveCaller?: true, adoptTeammates?: false, teamTaskPolicy?: 'clear-team' | 'preserve-team' | 'skip' })`
**返回**:`{ mode, planId, worktreePath, sessionId, cwd, teamId, archived, teammatesShutdown, taskReassignment, ... }`

**要点**:
- **adapter**(默认 `claude-code`):**省略一律起 claude-code session,与 caller 的 adapter 无关**。codex lead 想接力到另一个 codex session 必须显式传 `'codex-cli'`
- **cwd**:plan-driven 默认 mainRepo(worktree 被 archive_plan 删后仍 valid);generic 默认 caller cwd。当前 cwd 不对就显式传——别在本 session `cd`(codex shell 跨 turn 切 cwd 不持久)
- **archiveCaller**(默认 true):单向 baton。传 false 让 caller 留着并行做事,可多次起 session
- **teamName**(默认不加):纯 baton 不需要;要让新 session 和原 teammate 继续通信才传
- **adoptTeammates: true**:新 session 接管 caller 的 team 当 lead,原 teammate 继续可达。要求 caller 至少在一个 team 是 lead,且与 teamName 互斥
- **新 session cold-start 5 步**(plan-driven):见下方 §plan cold-start protocol(codex 端 5 步)
- **prompt 太长装不下** → 先落盘 `/tmp/handoff-<id>.md`,prompt 写「先 `shell: cat <abs-path>` 再按文件推进」
- **要并行子任务而非交接身份** → 用 `spawn_session` 不是 hand_off_session

**caller 的 task 怎么过继**（`teamTaskPolicy`,仅 archiveCaller=true 时执行）:

| policy | 行为 |
|---|---|
| `clear-team`(默认)| task 过继给新 session 并清 teamId 变 personal——新 session 不必加 team 就能读写,最省心 |
| `preserve-team` | 过继但保留 teamId(配合 adoptTeammates 让新 session 当 lead 后仍能写)。新 session 没进对应 team 则写不了,return 里 `policyWarning` 提示 |
| `skip` | 直接删 caller 的 team task(plan 收口后丢弃中间 task),personal task 仍过继 |

### plan cold-start protocol(codex 端 5 步)

新 codex session 收到 `按 <plan-abs-path> 接力` 这类 cold-start prompt 时,**必做** 5 步:

1. `shell: cat <plan-abs-path>` 读 plan 全文(codex 无 native Read tool;跨会话第一次读文件务必走真 fs)
2. frontmatter 拿 `worktree_path` + `plan_id`(snake_case)。worktree 已存在(典型接力)→ 直接用绝对路径推进,**不要** `enter_worktree`(它只创建新 worktree,拒绝复用);plan 还在新建阶段路径不存在 → `enter_worktree({ planId, baseCommit: <frontmatter.base_commit> })` 创建(`baseCommit` 显式传避撞 stale base bug)
3. 自检 `shell: git -C <worktree-path> log --oneline -3`,确认 HEAD = frontmatter `base_commit` / `final_commit` 或之后
4. 按 plan §下一会话第一步 动手:**不重新讨论 §设计决策**;**所有 shell / 路径显式指向 worktree**(`git -C <worktree-path>`),codex SDK cwd 没切
5. 进度 / §设计决策 / §不变量 变更先告诉用户确认

> claude 视角对应 protocol 在 `resources/claude-config/CLAUDE.md` §复杂 plan：Agent Deck baseline 最小协议 §Handoff。

### codex SDK 特有:per-session token / spawn options default

codex teammate spawn(`adapter: 'codex-cli'`)走应用层默认 enforce 一组 spawn options(reviewer-* 必需):
- `sandboxMode: 'workspace-write'`(SDK 默认档;`approvalPolicy: 'never'` 配合不弹审批)
- `approvalPolicy: 'never'`(SDK 无 UI 弹审批会挂)
- `networkAccessEnabled: true`(reviewer-codex teammate 调 OpenAI API;cross-adapter pair 时 reviewer-claude 跑在 claude SDK 端不走本 default)
- `additionalDirectories: ['~/.claude', '~/.codex', '/tmp']`(reviewer 跨目录读 plan / claude config / codex config 文件 + cache 中间文件落 `/tmp`)
- 只有内部 createSession 调用方能覆盖完整 codex SDK options；MCP `spawn_session` 当前仅暴露 `codexSandbox` / `permissionMode` 等白名单字段,**不**暴露任意 `additionalDirectories` / `networkAccessEnabled` override。需要读默认范围外文件时,走 deep-review SKILL auto cp 或把文件复制到 worktree/repo cwd / `~/.claude` / `~/.codex` / `/tmp` 后再传 scope

per-session MCP token 机制 — 应用启动 codex 子进程时分发一次性 token 让本应用 MCP server 反查 caller，工作流：
- 应用 spawn 新 codex SDK session 时为它分配 per-session token，通过环境变量 `AGENT_DECK_MCP_TOKEN` 注入子进程
- codex CLI 通过 `bearer_token_env_var: 'AGENT_DECK_MCP_TOKEN'` 读 env var 拼 HTTP `Authorization: Bearer <token>` 头连 streamable HTTP MCP server
- 应用端 MCP server 收到 Bearer token → 反查回 caller `sessionId` 自动填入 tool handler（caller 不必手动传 `callerSessionId` arg）
- 全局 token fallback（外部 codex CLI 走 `process.env.AGENT_DECK_MCP_TOKEN` 全局值）只读不能写（spawn / send / archive 等高危 tool deny external caller）


## Issue 上报(report_issue / append_issue_context / update_issue_status)

执行中踩到「该记下来、但不该现在动手」的问题 → 用 mcp tool 落 issue tracker,别默默吞掉。三个 write tool 的完整签名 / 参数见各自工具描述,本节只讲**何时用**。agent 只写不查(无 list / get / delete),查询 / triage / 删除走应用 UI。callerSessionId 由 per-session token 自动反查填入,codex 端不必手传。

### 何时上报

发现以下任一、且**不在当前任务交付范围内** → `report_issue`:

| kind | 场景 |
|---|---|
| `follow-up`(default)| 当前任务暴露的后续工作(本轮 scope 外但该做)|
| `app-bug` | Agent Deck 应用本身的 bug |

**不上报**:
- **当场能顺手修的,直接修**——report 是留给「scope 外 / 需后续跟进」的,不是给自己当下能解决的事记 TODO
- 当前任务直接要交付的内容(直接做)
- 一次性 trivial 观察
- 怕重复而不报:agent 查不了已有 issue,宁可重报由 UI 合并

### 上报后

- **补现场** → `append_issue_context`:给本会话刚 report 的 issue(用返回的 `id`)追加上下文。只能补自己的、还没 resolved 的 issue。
- **改状态** → `update_issue_status`:自己修好了标 `resolved`,要重开标 `open`;仅源会话 / 解决会话能改,不用等人去 UI 点。
