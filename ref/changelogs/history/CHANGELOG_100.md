# CHANGELOG_100 — Agent Deck MCP 协议大简化(10 → 7 tool)+ wire format 双锚点 + 文档去冗余

## 概要

Agent Deck MCP 协议大幅简化:删 `reply_message` / `wait_reply` / `check_reply` 三个 tool + universal-message-watcher J fix(reply 短路拦截)+ wait-reply nudge 机制。统一 `send_message` 为唯一发消息入口,所有 reply 改用 `send_message + reply_to_message_id`,与普通 send_message 同款走 adapter dispatch 自动注入 receiver SDK conversation flow(receiver Claude 看到 user-role message 直接 act on it,无需 lead/teammate 主动 poll)。

同步升级:wire format 从单锚点 `[from <name> @ <adapter>][msg <id>]` 升级为双锚点 `[from <name> @ <adapter>][msg <id>][sid <senderSessionId>]`,让 teammate 从 wire prefix 直接拿到 lead session_id 调 send_message 回 lead;spawn handler 注入 lead context block(Lead session_id / Team id / displayName + send_message 用法说明),双层冗余防协议漂移。Renderer 端 message-row.tsx 加 hand-off context disclosure(默认收起)+ chip 显示 senderSessionId 短 hash。

附加文档大幅去冗余:删所有 CHANGELOG/Phase/K2/start_next_session 历史代号引用 + 老协议 vs 新协议对比叙事 + 废弃模式声明 + 未来假设 + 重复内容(SKILL.md dormant 节合并到 CLAUDE.md)。

净改动:12 文件 +259 行 / -510 行(净删 251 行)。

## 变更内容

### Phase A — backend mcp tool 删除 + J fix 删除 + spawn 注入 + wire format 改造

- **删 3 个 tool 文件**(`tools/handlers/{reply,wait,check}.ts`)+ `tools/index.ts` 注销 + `tools/schemas.ts` 删 schema/types + `types.ts` 注释更新 + `tools/helpers.ts` 删 wait-reply 专用 helper
- **删 J fix**(`universal-message-watcher.ts:435-465`):`if (claimed.replyToMessageId != null)` 直接 markDelivered + return 不 dispatch 的旧逻辑删除 → reply 现在与普通 send_message 同款走完整 adapter dispatch 链(adapter.receiveTeammateMessage → adapter.sendMessage → receiver SDK emit user-role event)
- **删 wait-reply event listener 机制**(随 wait.ts 删除自动消失;`emit('agent-deck-message-enqueued')` 仍保留 renderer fan-out 用)
- **删 `agentDeckMessageRepo.findRepliesByMessageId`** method(interface + impl + facade entry 全删)
- **spawn handler 注入 lead context block + wire format sid 字段**(`tools/handlers/spawn.ts`):
  - `team ensureByName` 提到 `createSession` 之前(让 wire prefix + lead context block 注入 prompt 时能用真实 teamId)
  - 拼装 `[from <leadName> @ <leadAdapter>][msg <id>][sid <leadSid>]\n` + lead context block(Lead session_id / Team id / displayName + send_message 用法 + wire prefix regex 双锚点) + `\n---\n\n` + 原 promptToUse
  - DB messages.body 仍存原始 promptToUse(不含 wire prefix / lead context block)
  - leadDisplayName fallback:`leadRecord.title ?? <adapter>:<sid 前 8>`(同 buildWireBody.resolveFromDisplayName)
- **wire-prefix.ts parser regex 升级**:`/^\[from ([^\]]+) @ ([^\]]+)\](?:\[msg ([^\]]+)\])?(?:\[sid ([^\]]+)\])?\n/`,新增 `senderSessionId` 字段(optional,老 wire 兼容)
- **`buildWireBody`**(`universal-message-watcher.ts`)同步升级写入 `[sid <fromSessionId>]` 段
- **send_message handler cross-team 防御已覆盖**(`tools/handlers/send.ts`):reply_to_message_id 反查 original.teamId === resolved teamId,本 phase 评估覆盖足够不动

### Phase B — UI / settings 删除 + spawn 渲染优化

- **`Settings → AgentDeckMcpSection.tsx`** 删 wait_reply timeout 字段
- **`shared/types/settings.ts`** 删 `mcpWaitReplyIdleQuietMs` 字段 + `settings-store.ts` REMOVED_KEYS array 加 migration entry
- **`SessionDetail/MessagesPanel.tsx`** 注释 + 文案更新(`reply_message` → `send_message`)
- **`activity-feed/rows/message-row.tsx`**:
  - 加 `parseHandOffContext(body)` helper:识别 spawn 注入的 `## Hand-off context (auto-injected by Agent Deck MCP)` marker + `\n---\n\n` separator,把 lead context block 抽出到独立 `<details>` disclosure(默认收起),body 主区只显示 `---` 之后的真正 prompt
  - chip 显示 `↩ {wirePrefix.from} · {senderSessionId.slice(0,8)}` 8-char hash;hover title 显示完整 sid + msgId
  - max-w-[12rem] → max-w-[16rem] 适应更长信息

### Phase C — 单测 + 文档大改

- **`tools.test.ts`** 删 wait_reply 9 case + check_reply 4 case + reply_message 1 case(共 14 case),mock 同步删 `mockReplies` / `findRepliesByMessageId`(共减 295 行);`Phase B7` 测试更新到新 wire format 三段断言 + lead context block marker 断言
- **`universal-message-watcher.test.ts`** 改写 J fix 3 case → 「reply 走 dispatch」+「reply target 已删 markFailed(语义反转)」+「non-reply 走 dispatch」
- **`wire-prefix.test.ts`** 加 sid 字段断言:CHANGELOG_100 双锚点格式 / B7 legacy(无 sid)兼容 / 边界(仅 sid 无 msg);共 11 case
- **5 处文档同步**(协议大改写):
  - `resources/claude-config/CLAUDE.md`(应用打包注入):tool 列表 10 → 7 / 删 wait_reply/check_reply 整节 / 加 §send_message 一统消息发送节 / 三个核心约定改为「reply 自动注入」心智模型
  - `resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md`:tool 列表 5-6 → 3-4(核心)/ 删 §timer fallback 节(check_reply 主路径没了不需要 cron 兜底)/ 删 §lead 必须自己 nudge 兜底 节 / 重写 §执行模板 7 步为 reply 自动注入流程 / 改写 lead 处理 reviewer 卡死流程
  - `resources/claude-config/agent-deck-plugin/agents/reviewer-{claude,codex}.md` 第 9/12 条 reply 协议大改:reply 用 `send_message + reply_to_message_id`,显式传 `session_id` + `team_id`,从 wire prefix 双锚点提取 + lead context block fallback
  - `docs/agent-deck-mcp-protocol.md` stub:tool 数 10 → 7 / SSOT 表 wire format 描述同步双锚点
  - `resources/claude-config/README.md`:数字更新

### 文档去冗余(用户反馈追加)

按用户「兼容历史描述很多不必要」反馈,5 类冗余全砍:
- **A 类(CHANGELOG/Phase/K2/start_next_session 历史代号)**:删 13+ 处 `CHANGELOG_45/56/97/98/99/100 / R2 deep review HIGH-1 / A5 升级 / K2 改名前 start_next_session` 引用,只保留事实
- **B 类(老协议 vs 新协议对比叙事)**:SKILL.md 整段 §「为什么 reply 自动注入而非主动 poll」5 行历史叙事 → 1 行现状描述
- **C 类(废弃模式声明)**:删 reviewer-{claude,codex}.md `subagent 模式已废弃` callout + CLAUDE.md inbox 协议历史段
- **D 类(未来假设/实现细节)**:删 reviewer-{claude,codex}.md「未来若换 id 生成器」尾巴
- **E 类(重复内容)**:SKILL.md §dormant 9 行 → 1 行「详应用 CLAUDE.md §dormant」引用,避免双份维护漂移
- 同步去冗余:`~/.claude/CLAUDE.md`(user 全局)删 K2/CHANGELOG_99/start_next_session 历史代号

净改动 5 文档 -29 行(987 → 958)。

### Phase D — 双异构对抗 review + R2 修真问题

**reviewer 组合**：reviewer-claude (Opus 4.7) + reviewer-codex (gpt-5.5 xhigh) teammate 模式

**reviewer-claude finding**：0 HIGH / 4 MED / 3 LOW / 2 INFO
**reviewer-codex finding**：0 HIGH / 2 MED / 2 LOW / 1 *未验证* MED

**三态裁决 + must-fix 清单**：

#### ✅ 必修 (3 条)

1. **codex MED-1: displayName 未转义 `]` 会破坏 wire prefix 解析** — caller 控制的 session.title (e.g. "feat: [test]") 含 `]` 会让 `[from foo]bar @ ...]` parser regex 错位 → chip 不显示 / hand-off context 不折叠。
   - 修法：新增 `sanitizeWireFieldName()` helper (shared/wire-prefix.ts) 替换 `]`/`[`/`\n`/`\r` 为单空格 + trim + 空字符串 fallback。spawn handler `leadFromName` + `leadAdapter` 走 sanitize；buildWireBody (universal-message-watcher.ts) `displayName` + `adapterId` 走 sanitize。
   - 测试：wire-prefix.test.ts 加 7 个 sanitize case + 1 个 parser roundtrip 集成测试

2. **codex MED-2: spawn ensureByName 提前后 createSession 失败遗留 active 空 team** — D9 把 ensureByName 提到 createSession 之前，但 catch 路径没 cleanup 已新建的 team → active team 列表污染（无 lead / 无 teammate 的孤儿 team）。
   - 修法：新增 `teamCreatedNow` flag (用 `listAllMembers(team.id).length === 0` 判定刚 INSERT)；catch 路径再次 verify 空 team 后调 `hardDelete()` cleanup（防并发 caller 抢先 addMember 的边界 case）

3. **claude MED-1 + codex LOW-2 共识: tools.test.ts 缺 cross-team `reply_to_message_id` reject 测试覆盖** — 删 wait_reply describe 后，send.ts:91-105 的 cross-team reject 防御失去测试覆盖。
   - 修法：tools.test.ts send_message describe 补 3 case：`reply_to_message_id` 不存在 → reject "not found"；`reply_to_message_id` 跨 team → reject "cross-team reply not allowed"；same-team `reply_to_message_id` 透传到 enqueue

#### ❓ 单方 MED 评估为 follow-up (3 条)

4. **claude MED-2: universal-message-watcher.test.ts 改写后缺 retry / backpressure 测试** — 评估：retry / backpressure 在改写前就缺，不是 CHANGELOG_100 引入的回退；属于 follow-up
5. **claude MED-3: spawn 注入 lead context block 仅 first-time，后续 send_message wire prefix 没有 team_id 锚点** — 评估：reviewer agent body 第 9/12 条已描述 `list_sessions` fallback 兜底；future 可选的 `[team <id>]` 第四段属协议层增强非 bug，留下次 review 评估
6. **claude MED-4: chip inline-flex + truncate 不显示 ellipsis (CSS limitation)** — 标 *未验证* + 触发条件极罕见 (>28 字符 displayName)，hover title 已有完整信息，降级为 LOW 不阻塞

#### ❓ LOW / *未验证* / INFO (follow-up)

7. **claude LOW-1/2/3 / codex LOW-1 / codex *未验证* MED**：edge case 或文档清理 follow-up
8. **claude INFO-1**: 多处注释残留 wait_reply / reply_message / check_reply 字样 (~14 处)，列下次 review expired-file 清单
9. **claude INFO-2**: v015 migration 的部分索引 `WHERE reply_to_message_id IS NOT NULL` 可能 dead，下次 schema migration 时一并评估

**修复 commit**：本 phase 全部 must-fix 与 Phase B+C 一起 squash 到本 plan 收口 commit。

### Phase D 修复涉及文件 (R2)

- **src/shared/wire-prefix.ts** — 加 `sanitizeWireFieldName()` helper export
- **src/shared/__tests__/wire-prefix.test.ts** — 加 8 个新 case (7 sanitize + 1 roundtrip 集成)
- **src/main/agent-deck-mcp/tools/handlers/spawn.ts** — leadFromName/leadAdapter 走 sanitize + teamCreatedNow flag + cleanup on createSession fail
- **src/main/teams/universal-message-watcher.ts** — buildWireBody displayName/adapterId 走 sanitize
- **src/main/agent-deck-mcp/__tests__/tools.test.ts** — 加 3 个 send_message reply chain case + 补 listAllMembers/hardDelete mock

## 影响

- **caller 心智模型大幅简化**:从「lead 主动 wait_reply / check_reply 拉 reply」变成「lead 把 reply 当作普通 user message 收到」。SKILL 编排 7 步从「user-driven check_reply poll + cron timer 兜底 + 自己 nudge」简化为「reply 自动注入 lead conversation 等就行」
- **wire format breaking change**:`[from][msg][sid]` 三段双锚点是新协议;parseWirePrefix 兼容老 wire(无 msg / 无 sid 都 optional),但 teammate 协议规范升级为「regex 必抓 sid」(reviewer-{claude,codex}.md 第 9/12 条)
- **DB schema 不破坏**:`agent_deck_messages.reply_to_message_id` 字段保留(对话链记录有用),只删 tool 不删数据。`messages` 子表全保留,SessionDetail「跨会话」tab 仍可查询 reply chain 历史
- **CHANGELOG_99 cwd resilience / archive_plan 自动归档 caller / hand_off_session 双模式 / baton 不计 spawn_depth** 全保留(本 plan 不动这些机制)
- **历史 changelog(CHANGELOG_91-99)** 引用 reply_message / wait_reply / check_reply 字样保留作历史记录,不动

## 验证

- `pnpm typecheck` 全绿(node + web 两 project)
- `pnpm exec vitest run src/main/agent-deck-mcp src/main/teams src/shared`:93/97 通过(4 个失败是 Electron binding 本地环境问题,与本 phase 改动无关 — 详 CLAUDE.md §「跑 vitest SQLite 真测前后必须保护 better-sqlite3 binding」)
