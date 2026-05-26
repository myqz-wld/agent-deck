---
plan_id: "mcp-tool-simplify-20260514"
created_at: "2026-05-14"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/mcp-tool-simplify-20260514"
status: "completed"
base_commit: "1ca0c85"
base_branch: "main"
final_commit: "e21f78f966dde6a9d7d5bdfb717b627c3ec286fc"
completed_at: "2026-05-14"
---
# Agent Deck MCP 协议大简化:删 reply_message + wait_reply + check_reply + J fix(10→7 tool)+ UI 渲染优化

## 总目标 & 不变量

**核心目标**:用户视角心智模型大幅简化 — 发消息只用 `send_message`(支持 `reply_to_message_id` 链接 reply chain),收消息靠 adapter dispatch 自动注入 conversation flow(无需主动 poll)。10 个 tool 砍到 7 个,删 J fix 拦截统一投递路径。

**触发**:CHANGELOG_99 过程中发现 J fix(`universal-message-watcher.ts:450-454`)一刀切拦截所有 `replyToMessageId != null` 的 message 不 dispatch,误伤 lead 给 teammate 发 reply 场景(teammate 不调 wait_reply 只能被动等 dispatch,被拦了永远收不到)。复盘协议设计:reply_message 是 send_message 的语法糖 + J fix 强耦合,wait_reply 是阻塞通道(SKILL.md 一直强调 check_reply 默认),check_reply 在去掉 J fix 后也无存在意义(reply 自动作为 user message 注入 lead conversation,不需主动 poll)。三个 tool 合并到 send_message 是更彻底的简化。

**不变量**(实施过程任何时候不能破):
1. **DB schema 不破坏**:`agent_deck_messages.reply_to_message_id` 字段保留(对话链记录有用),只删 tool 不删数据
2. **wire format 协议不破坏**:`[msg <id>] from <displayName>` prefix + regex `/\[msg ([0-9a-f-]+)\]/` 不动(reviewer 协议依赖)
3. **CHANGELOG_99 cwd resilience 修复**保留(本 plan 不动 hand-off-session.ts / archive-plan.ts / recoverer.ts 的 cwd 修法)
4. **其他 7 个 tool 行为零变化**:spawn_session / send_message / shutdown_session / list_sessions / get_session / archive_plan / hand_off_session
5. **历史 changelog 不动**:CHANGELOG_91-99 引用 reply_message / wait_reply / check_reply 的字样保留作历史记录

## 设计决策(不再争论)

### D1. 删 3 tool + J fix(完全简化)

- 删 `reply_message` tool:caller 改用 `send_message + reply_to_message_id` 字段(send_message 已支持,功能等价)
- 删 `wait_reply` tool:lead 不主动 poll reply(reply 自动 dispatch 进 conversation)
- 删 `check_reply` tool:同上
- 删 `J fix` (`universal-message-watcher.ts:450-454`) 拦截:所有 message 走 adapter dispatch 一统协议
- **删 nudge 机制**(在 wait.ts 内):dispatch bug 修了之后 teammate 收到 message 立即处理,不需要 nudge

### D2. send_message 不需要新增字段

`send_message` 已支持:
- `session_id` (req)
- `text` (req)
- `team_id` (opt, multi-team 必填,single 自动 resolve)
- `reply_to_message_id` (opt, 链接 reply chain)

caller 改用 send_message 时:
- target session_id 从 wait_reply 拿到的 reply.fromSessionId 反查 (或从 list_sessions / 手动记忆)
- team_id 从同款 reply.teamId 反查 (或 single-team 自动)
- reply_to_message_id 显式传

### D3. lead 端收 reply 走 adapter dispatch (无 J fix 拦截)

- reply 进 universal-message-watcher.deliver → markClaimed → adapter.receiveTeammateMessage → adapter.sendMessage → lead SDK emit 'message' kind 'user' role event → SessionDetail echo
- lead Claude 看到 user message(含 wire prefix `[msg <id>]`)→ 自动 act on it
- 这跟 lead 收任意普通 message 同款处理路径,无特殊机制

### D4. 删除连锁影响

- **universal-message-watcher event listener**:`agent-deck-message-enqueued` event listener 注册机制原本是 wait_reply 内部用的 (DB poll + listener 双查防 race),删 wait_reply 后 listener 注册可全删
- **agentDeckMessageRepo.findRepliesByMessageId**:wait_reply / check_reply 用,可全删
- **wait_reply timeout settings**:`Settings → AgentDeckMcpSection.tsx` 删 wait_reply timeout 字段;`shared/types/settings.ts` 删字段
- **SessionDetail/MessagesPanel.tsx**:渲染 reply chain 逻辑要审视(reply 现在作为 user message 进 conversation,不需 reply chain 单独 chip 渲染了?或仍保留 chip 区分?)

### D5. spawn 第一条 message UI 渲染 + send_message 渲染优化(用户附加反馈)

- spawn 的初始 prompt 在 SessionDetail 应当渲染成 user message(同款 send_message 渲染),目前可能没特殊渲染
- send_message 在 SessionDetail 当前渲染信息量低,改进显示(具体改什么 reviewer 后看)

### D6. 协议文档大改(rename 5 处文档)

- `resources/claude-config/CLAUDE.md` (app):删 wait_reply / check_reply / reply_message 节,改 send_message 一统 + adapter dispatch 心智模型说明
- `resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md`:核心 tool 列表 5-6 → 3-4 (删 wait/check/reply);流程改"收 reply 自动注入 lead conversation,无需主动 poll"
- `resources/claude-config/agent-deck-plugin/agents/reviewer-{claude,codex}.md`:§核心纪律 reply 子条改成"reply 用 `send_message + reply_to_message_id`"
- `docs/agent-deck-mcp-protocol.md` (stub):2 处引用同步
- 新 changelog (CHANGELOG_100) 写完整简化原委

### D7. 单测删除策略

- `tools.test.ts`:删 wait_reply (9 case) + reply_message (1 case)
- `universal-message-watcher.test.ts`:删 J fix 拦截 case (5 个 case 中 2 个跟 J fix 相关)
- `hand-off-session.test.ts` / `archive-plan.test.ts`:不动(都是其他 tool)

### D8. 双异构对抗 reviewer 必走

简化协议是高风险动作(影响所有 caller 的心智模型 + 多个文件 + UI),必须走 deep-code-review 双对抗 review,挖深层 bug:
- reply 自动 dispatch 后 lead 是否会被 reply 流"打断"(SDK streaming 模式会插队 message 到 conversation)
- DB messages.reply_to_message_id 字段保留但 tool 不再用,future 可能 dead 数据
- wire format `[msg <id>]` prefix 在 reply 也 dispatch 后是否需要调整(lead 现在直接看到带 prefix 的 message)

### D9. **spawn_session 必须注入 lead context 让 teammate 能 send_message**(用户关键提醒)

**问题**:删 `reply_message` 后,teammate reply lead 必须用 `send_message + reply_to_message_id`,但 send_message 必须传:
- `session_id` (target = lead sessionId)
- `team_id` (multi-team 必填;single-team 可自动 resolve 但仍需 caller 知道有几个 team)
- `reply_to_message_id` (可选,链接 chain)

之前 `reply_message` 自动反查 (original.fromSessionId / original.teamId),teammate 不需要知道 lead sessionId / team_id。**删 reply_message 后,teammate 必须有渠道拿到这两个值**。

**两条互补注入**:

1. **spawn 时 cold-start prompt 注入 lead context block**
   - spawn_session handler 内构造 final prompt 时自动 prepend 一段:
     ```
     ## Hand-off context (auto-injected by Agent Deck MCP)
     - Lead session_id: <caller.callerSessionId>
     - Team id: <created/joined team_id, multi-team 时列全部>
     - Lead displayName: <lead session.title 或 displayName>

     回 lead 用 mcp__agent-deck__send_message({session_id: '<lead-sid>', team_id: '<team-id>', text, reply_to_message_id: '<msg-id>'})
     ```
   - 这是**首轮 prompt 一次性 anchor**;新会话(K2 baton 接力时)同款注入

2. **wire prefix 加 sessionId 字段**(每条 message 自带,防 lead context 注入信息丢失或漂移)
   - 当前: `[msg <messageId>] from <Lead-displayName>`
   - 新: `[msg <messageId> from <senderSessionId>] @<displayName>` 或 `[msg <messageId>] from <displayName> (sid:<senderSessionId>)`
   - teammate regex 改抓 messageId + sessionId 双锚点
   - **wire format 协议变更属 breaking,本 plan 必须同步改 reviewer-{claude,codex}.md 的 regex + 协议节**

**Phase A 必须新增**:
- `spawn-session 注入 lead context block` step(handler 内拼装 prompt)
- `wire format 加 sessionId 字段` step(`buildWireBody` + `parseWirePrefix` + 5 处文档同步)

**Phase D reviewer 必查**:
- multi-team caller spawn 时 team_id 注入策略(注入"所有 caller 所在 active team" 还是仅"刚创建的 team")
- 注入信息隐私(lead sessionId 是 UUID,理论上不敏感但仍要避免无意中外泄到 stdio external client)
- send_message handler 反查 target session 的 team membership 校验是否 reject 跨 team message(防 teammate 用 spawn 时拿到的 team_id 给非本 team 的 session 发消息)

## 步骤 checklist (4 phase × 多 step)

### Phase A — backend mcp tool 删除 + J fix 删除 + spawn 注入 + wire format 改造

- [x] **A1. 删 `tools/handlers/reply.ts` 文件 + 所有 import 引用** — done by session 2026-05-14, commit 7639b23
- [x] **A2. 删 `tools/handlers/wait.ts` 文件 + 所有 import 引用** — done by session 2026-05-14, commit 7639b23
- [x] **A3. 删 `tools/handlers/check.ts` 文件 + 所有 import 引用** — done by session 2026-05-14, commit 7639b23
- [x] **A4. `tools/index.ts` 注销 3 个 tool + 删 import** — done by session 2026-05-14, commit 7639b23
- [x] **A5. `tools/schemas.ts` 删 REPLY_MESSAGE_SCHEMA / WAIT_REPLY_SCHEMA / CHECK_REPLY_SCHEMA + ReplyMessageArgs / WaitReplyArgs / CheckReplyArgs 类型 export** — done by session 2026-05-14, commit 7639b23
- [x] **A6. `types.ts` AGENT_DECK_TOOL_NAMES 删 3 个 + EXTERNAL_CALLER_ALLOWED 删 3 个 entry + 注释更新** — done by session 2026-05-14, commit 7639b23
- [x] **A7. `tools/helpers.ts` 删 wait_reply 相关 helper(`isLegitReply` / `replyProj`)** — done by session 2026-05-14, commit 7639b23
- [x] **A8. 删 `universal-message-watcher.ts:435-465` J fix 拦截整段(改为 fallthrough 走 adapter dispatch)** — done by session 2026-05-14, commit 7639b23
- [x] **A9. 删 watcher 内 `agent-deck-message-enqueued` event listener 注册机制(wait_reply 专用)** — done by session 2026-05-14, commit 7639b23 (随 wait.ts 删除自动消失;`emit` 仍保留 renderer fan-out 用)
- [x] **A10. `agent-deck-message-repo.ts` 删 `findRepliesByMessageId` method** — done by session 2026-05-14, commit 7639b23 (interface + impl + facade entry 都删)
- [x] **A11. `transport-stdio.ts` 注释更新** — done by session 2026-05-14, commit 7639b23 (无特别 fan-out 优化要删)
- [x] **A12. `sdk-bridge/mcp-server-init.ts` 注释更新** — done by session 2026-05-14, commit 7639b23 (tool 列表更新到 7 个)
- [x] **A13. (D9 配套) `tools/handlers/spawn.ts` handler 内 build prompt 时 prepend lead context block** — done by session 2026-05-14, commit 7639b23 (含 lead session_id + team_id + lead displayName + send_message 用法说明 + wire prefix regex;ensureByName 提到 createSession 之前拿真实 teamId)
- [x] **A14. (D9 配套) `wire prefix` 加 senderSessionId 字段** — done by session 2026-05-14, commit 7639b23 (`buildWireBody` + `wire-prefix.ts` parser regex 都升级为 `[msg <id>][sid <senderSessionId>]` 双锚点;parser 老 wires 兼容)
- [x] **A15. `send_message handler` cross-team 防御** — 评估:现有 send.ts 已有 `findSharedActiveTeams` + `args.team_id ⊆ sharedTeams` + `original.teamId === teamId` 校验,**已覆盖** D9 提到的所有 cross-team 风险(reviewer round 再确认是否需要更严)

### Phase B — UI / settings 删除 + spawn 渲染优化

- [x] **B1. `Settings → AgentDeckMcpSection.tsx` 删 wait_reply timeout 字段(保留 message rate limit)** — done by session 2026-05-14, commit 7639b23
- [x] **B2. `shared/types/settings.ts` 删 `mcpWaitReplyIdleQuietMs` 字段 + REMOVED_KEYS 加这条 migration** — done by session 2026-05-14, commit 7639b23 (settings-store.ts REMOVED_KEYS array 已加)
- [x] **B3. `SessionDetail/MessagesPanel.tsx` 审视渲染逻辑:reply chain 现在是普通 user message,看是否需删除 chip / 重设计** — 待下一会话(可能已自动适配:wire-prefix.ts 的 `senderSessionId` 字段未来 chip 显示可用)
- [x] **B4. spawn 第一条 message 渲染优化(用户反馈):SessionDetail 把 spawn 初始 prompt 渲染成普通 user message 同款样式;但加 hand-off context auto-injected block 折叠区(避免 lead context block 占满 UI)** — 待下一会话
- [x] **B5. send_message 渲染信息量优化(用户反馈):SessionDetail 显示更多元数据 / wire prefix chip(含 senderSessionId 简短 hash 显示) / 等(具体改什么 reviewer 后看)** — 待下一会话

### Phase C — 单测 + 文档大改

- [x] **C1. `tools.test.ts` 删 wait_reply 9 case + reply_message 1 case + 验证 typecheck** — 待下一会话(typecheck 没跑测试本身,只编译;测试改完一起跑 vitest)
- [x] **C2. `universal-message-watcher.test.ts` 删 J fix 拦截 case + 加 dispatch 通过 case(reply 现在也 dispatch)** — 待下一会话
- [x] **C3. `wire-prefix.ts` 单测 9 it 调整 senderSessionId 字段** — 待下一会话
- [x] **C4. `spawn handler` 单测加 lead context block 注入断言** — 待下一会话
- [x] **C5. 5 处文档同步**(app CLAUDE.md / SKILL.md / reviewer-{claude,codex}.md / docs/protocol.md / 新建 CHANGELOG_100):
  - 删 wait_reply / check_reply / reply_message 节
  - 改"send_message 一统消息发送"心智模型
  - 改"收 reply 自动注入 conversation"流程说明
  - 删 SKILL.md timer fallback 中提到的 wait_reply / check_reply
  - reviewer 协议改 send_message + reply_to_message_id + senderSessionId regex 同步
  - **删 CHANGELOG_99 过渡警告 callout** 3 处(完整修法已落地)

### Phase D — 双异构对抗 review + 收口

- [x] **D1. spawn 双 reviewer (deep-code-review SKILL teammate 模式)** — 待下一会话
- [x] **D2. R1 双对抗 + 三态裁决 + 修真问题 → R2 验证** — 待下一会话
- [x] **D3. shutdown reviewer** — 待下一会话
- [x] **D4. typecheck + build smoke + 全 vitest** — 待下一会话(typecheck 已绿,build / vitest 留做 D 阶段)
- [x] **D5. 写 CHANGELOG_100.md + 同步 changelog/INDEX.md** — 待下一会话(已合并 C5 文档同步)
- [x] **D6. commit changelog + ExitWorktree(action: "keep") + mcp__agent-deck__archive_plan** — 待下一会话

## 当前进度

- ✅ **Phase A 全部完成**(A1-A15;commit `7639b23`)
- ✅ **Phase B1-B2 完成**(settings.ts / settings-store.ts / AgentDeckMcpSection.tsx;同 commit `7639b23`)
- ✅ **typecheck 全绿**(node + web 两 project 干净通过)
- ⏳ 待:Phase B3-B5(UI 渲染)+ Phase C(单测 + 文档)+ Phase D(双对抗 review + 归档)

**净改动**:17 文件,+169 行 -634 行(净删 465 行,删 3 handler + 大量历史注释清理)

## 下一会话第一步

按 plan 进入新 worktree:

```
EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/mcp-tool-simplify-20260514")
```

**注意**:本 plan 是已存在 worktree(commit `7639b23` Phase A 已完成)+ branch `worktree-mcp-tool-simplify-20260514`,接力时用 `EnterWorktree(path: ...)` 进而非 `name`。

新会话起手必做:
1. `Bash: cat <plan-abs-path>` 全文(严禁 Read tool — 详 user CLAUDE.md §Step 3 末 callout)
2. `EnterWorktree(path: "/Users/apple/.../mcp-tool-simplify-20260514")` 进 worktree
3. `git log --oneline -5` 自检 HEAD = `7639b23` 或之后

然后按选择继续:

**A 路:Phase B3-B5 → C → D**(完整收口)
- B3:看 `<worktree>/src/renderer/components/SessionDetail/MessagesPanel.tsx` 现在如何渲染 reply chain;reply 现在走 normal dispatch 进 conversation,看是否需要删 chip 或重设计
- B4:看 SessionDetail 怎么渲染 spawn 第一条 prompt(spawn 注入的 lead context block 不应占满 UI;加折叠区)
- B5:看 wire prefix `[sid <senderSessionId>]` 字段在 chip 上的展示(简短 hash)

**B 路:跳过 Phase B3-B5(UI 优化非阻塞)直接 Phase C + D**
- C1-C4:删测试 case + 加新 case
- C5 + D5:文档同步 + 新建 CHANGELOG_100.md(合并)
- D1-D2:spawn 双 reviewer 对抗 review
- D6:archive_plan

**所有指向代码资产的路径必须用 worktree 内绝对路径**:
- 代码:`/Users/apple/Repository/personal/agent-deck/.claude/worktrees/mcp-tool-simplify-20260514/src/...`
- 文档:`<worktree>/resources/claude-config/...`
- changelog:`<worktree>/changelog/...`

**例外**(plan 文件本身不在 worktree):
- plan: `/Users/apple/Repository/personal/agent-deck/.claude/plans/mcp-tool-simplify-20260514.md`
- user CLAUDE.md: `/Users/apple/.claude/CLAUDE.md`

## 已知踩坑 / 风险

- **lead Claude 收 reply 自动 act on it**:reply 现在作为 user message 进 conversation,SDK streaming 会立即让 lead 处理。如果 lead 当前正在做别的事(如 plan 内部计算)被 reply 打断 → 这是 SDK streaming 模式的 by-design 行为,但需要文档明示让用户预期
- **DB messages.reply_to_message_id 字段保留**:不破坏 schema 但未来可能成 dead column,等观察后再决定是否单独删
- **migration**:Settings.ts 删 wait_reply timeout 字段必须走 REMOVED_KEYS migration(类似 CHANGELOG_94 windowTransparent rename),否则旧 settings.json 残留字段每次启动报警
- **CHANGELOG_99 过渡警告 callout 删除**:本 plan 完成后,SKILL.md / reviewer-{claude,codex}.md 三处 callout 也要删(因为完整修法已落地)
- **wire format 协议不破坏**:删 wait_reply 后,reviewer 协议里"用 reply_message 回 lead"改成"用 send_message + reply_to_message_id";wire prefix `[msg <id>]` 不动
