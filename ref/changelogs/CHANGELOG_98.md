# CHANGELOG_98

mcp 7 tool 文档 R1 deep review 25 finding + R2 反馈 9 项 + R3 收口（plan `mcp-handoff-fix-and-skill-timer-20260514`）：4 atomic commit。一次性收口 R1 4 HIGH + 8 MED + 用户提的 3 件事 + R2 反馈出 1 漏 HIGH (K2 baton spawn_depth) + 4 MED + 4 LOW + B14 dormant 踩坑反向应用沉淀，让 mcp tool 实际行为 / 文档 / SKILL 三者重新对齐 + 跨会话救火 / hand-off 触发 / dormant resume 三套反直觉踩坑彻底沉淀。

## 4 commit 时间线

1. **commit `438a613`** Phase A — mcp tool src 修复 7 项（H1+H2+H5 / M1+M2 / A4+A5）
2. **commit `0cc4f79`** Phase B — 文档大改 13 项（HIGH 文档 / 一致性 / 用户 3 件事 / LOW INFO 顺手）
3. **commit `58a5db9`** B14 — 「dormant ≠ 丢 mental model」反直觉踩坑沉淀到 3 处 md
4. **commit `4d48ef0`** Phase E + F — K2 baton spawn_depth fix + R2 反馈 1 HIGH + 4 MED + 3 LOW 收口

## 设计决策（未走对抗，单点）

D1-D10 详 plan §设计决策。重点：
- **D1 caller cwd 修法**：handler 层从 sessionRepo 反查注入 implDeps，不动 impl 接口（test inject 兼容）
- **D2 wait_reply nudge 死锁修法**：后端双查 originalId + nudgeIds + 返回 `nudgeMessageIds: string[]`（不破 wire format / reviewer 协议）
- **D3 tool name 统一为 `mcp__agent-deck__*`** 连字符（让 server.ts allowedTools pattern 真生效）
- **D4 hand-off 触发条件 §Step 2.5** 加在 user CLAUDE.md（agent 自检属 user-global 行为约束，不是 SKILL）
- **D5 SKILL check_reply timer fallback** 用 `CronCreate({recurring: true, durable: false})` session-only 周期 prompt（不阻塞 lead，user 离开期间也能推进）
- **D6 docs/agent-deck-mcp-protocol.md 降级 stub**（45KB ADR 长期与 5 份文档漂移，schemas.ts 才是 SSOT，stub 留指针即可）
- **D7 abandoned plan archive_plan 显式拒绝**（实现侧防御对齐文档约束）
- **D8 shutdown_session 不删数据列表补 messages + team_member soft-exit + spawn_link 全保留**

## Phase A — src 修复 7 项（commit `438a613`）

- **A1 (H5)** caller cwd bug 修：`start-next-session.ts` + `archive-plan.ts` handler 层加 `mergeCallerCwd` helper 从 `sessionRepo.get(callerSid)?.cwd` 反查注入 implDeps，impl deps 接口完全不动；2 caller-cwd test 全过
- **A2 (H2)** wait_reply nudge 死锁修：`wait.ts:20-185` 闭包收 `nudgeMessageIds: string[]` + `findRepliesAcrossAllAnchors([originalId, ...nudgeIds]).flatMap` 双查 + ok return 三处加 `nudgeMessageIds` 字段（race-safe early return / resolve / timeout 全覆盖）+ schemas.ts wait_reply nudge_text desc 同步澄清「内部已自动双查」
- **A3 (H1)** tool name pattern 修：`server.ts AGENT_DECK_MCP_TOOL_PATTERN` 改 `'mcp__agent-deck__*'` 连字符让 SDK pre-approve 真生效；41 处 src+docs+resources 文档批量替换
- **A4 (M7+D7)** abandoned plan 拒绝：`archive-plan-impl.ts:230-241` 加 abandoned + 缺失/非法 status 显式 reject；test 加 2 case
- **A5 (未验证 #1 升级)** start-next-session ok return 加 `archived: 'ok' | 'failed' | 'skipped'` 三态字段（caller 不必看 console.warn 即可感知归档结果）
- **A6 (M1+D8)** shutdown.ts 注释 + tools/index.ts shutdown_session description 同步补全（messages / team_member soft-exit / spawn_link 全保留）

typecheck pass + 90 mcp test 全过。

## Phase B — 文档大改 13 项（commit `0cc4f79`）

- **B1 (H3+D6)** `docs/agent-deck-mcp-protocol.md` 729 行 ADR → 30 行 stub + 真实 SSOT 路径表（指 SKILL.md / reviewer-{claude,codex}.md / app CLAUDE.md / `src/main/agent-deck-mcp/tools/schemas.ts`）
- **B2 (H4)** `resources/claude-config/CLAUDE.md` §跨会话救火 加 shared-team 前置 callout（同 caller / 跨 caller 三种续接姿势：spawn 重起 / UI join / K2 显式 team_name）
- **B3 (H6+D4)** `~/.claude/CLAUDE.md` §复杂 plan 加 §Step 2.5「何时主动 hand off」节（客观信号 + 用户语义信号 + 例外）
- **B4 (M4+D5+用户三件事 #3)** SKILL.md Step 2 严禁清单调整（阻塞型禁 / 非阻塞 OK）+ §timer fallback 子节（CronCreate `recurring: true, durable: false` 周期 7-10min 兜底 + CronDelete 三时机：双 reply / 进 fix 阶段 / shutdown_session）
- **B5 (H1)** user home 文档 tool name 4 处 `mcp__agent_deck__` → `mcp__agent-deck__`
- **B6 (H2 配套)** app CLAUDE.md §wait_reply 节 ok return shape 加 `nudgeMessageIds` + 加 nudge 死锁修复说明段
- **B7 (M2+A5 配套)** app CLAUDE.md K2 节 result shape 加 archived 三态字段 + archive 无条件原则 callout
- **B8 (M3)** SKILL.md L27「Opus 4.7 xhigh」→「Opus 4.7 default thinking」（reviewer-codex 那侧 gpt-5.5 xhigh 是真保留）
- **B9 (M5)** reviewer-{claude,codex}.md §核心纪律 reply 子条加 wire format id invariant 锚定（`crypto.randomUUID` v4 lowercase hex+hyphen / charset `[0-9a-f-]{36}` / 同步范围）
- **B10 (M6)** reviewer-{claude,codex}.md NO MSG ANCHOR fallback 完整化（退化路径用 send_message 不传 reply_to_message_id + list_sessions 反查 lead session_id + 最终兜底落 SDK assistant output）
- **B11 (M8)** `~/.claude/templates/reviewer-{claude,codex}.sh.tmpl` mktemp 走 `${TMPDIR:-/tmp}/<prefix>.XXXXXX` + 注释加 sandbox profile workspace-write 解释
- **B12 (M1+D8 文档侧)** app CLAUDE.md L38「shutdown 不删数据」补 team_member soft-exit + spawn_link 全保留
- **B13 LOW + INFO 顺手** SKILL.md「10 个 tool」→「5-6 核心 + 4-5 救火」/「6 步」→「7 步」/ Step 5 加 skip 字段格式示例 / app CLAUDE.md §Agent Teams stale ref 改写 + L37 send_message replyToMessageId 加「首条 null」+ L56 stub 配套改 / README.md mcp 7→10 tool 2 处 / reviewer-codex.md mktemp 注释加 sandbox profile workspace-write deny `/var/folders/...` 详细解释

typecheck pass。

## B14 — dormant ≠ 丢 mental model 反直觉踩坑沉淀（commit `58a5db9`）

R2 spawn 决策时我误推理「dormant 等于丢 in-memory state = 必须 spawn 新一对」→ user 提醒 SDK 有 resume 机制 → 现场实践验证 `recoverer.ts:103-220` dormant + send_message 路径触发 `createSession({resume: oldSid})` 复原对话历史 = mental model 通过 conversation history 隐式保留 ✅。

补 3 处文档防再踩：
- 应用 CLAUDE.md「shutdown 不删数据」节末加 callout「dormant ≠ 丢 mental model」原则 + 触发条件 + 反例 (jsonl 缺失走 hard fail fallback 才真 fresh)
- SKILL.md Step 6 收尾行加「想日后复用 reviewer 不要 shutdown 留 dormant」hint + 失败兜底节后新增独立子节 §dormant ≠ 丢 mental model（反直觉）
- reviewer-{claude,codex}.md FRESH SESSION 自检条款加子条「dormant 唤醒不算 fresh」澄清

机制 SSOT：`src/main/adapters/claude-code/sdk-bridge/recoverer.ts:103-220` + user CLAUDE.md「会话恢复 / 断连 UX」节。

## Phase E + F — R2 deep review 收口 + R3 验证（commit `4d48ef0`）

R2 双 reviewer (claude + codex) 一致裁决「fix 部分通过 + 列残留 — 暂不可合」：1 HIGH (K2 baton spawn_depth) + 4 MED + 3 LOW + R2 *未验证* #1 codex namespace（follow-up 不阻塞）。

### E1 (HIGH): K2 baton spawn_depth 误判修

R1 漏掉的真问题：`spawn-guards.ts:60-77` `maxDepth=3` 限制对 K2 baton 接力误判（baton 单向交接 + caller 自动归档不构成 fork-bomb 风险，N-phase 接力链不该撞默认 max=3）。

**双 reviewer 一致警告「双改必须同步」**：仅跳 spawn-guards depth check 不改 setSpawnLink → depth 4/5/... 累积污染后续普通 spawn 仍被拒。

实施三改：
- `spawn-guards.ts.applySpawnGuards` 加 `opts?: { batonMode?: boolean }` 第 4 参 → batonMode=true 跳 depth check（fan-out + rate-limit 保留，防 spam baton）
- `spawn.ts.spawnSessionHandler` 加 `opts?: { batonMode?: boolean }` 第 3 参 → 透传 guard + setSpawnLink batonMode 时写 `parentDepth`（lateral 不 +1）+ ok return spawnDepth fallback 同步 batonMode 三元
- `start-next-session.ts:154` 调 `spawnFn(spawnArgs, ctx, { batonMode: true })`
- `spawn-guards.test.ts` 加 4 case：batonMode=true 跳 depth / fan-out 仍 enforce / rate-limit 仍 enforce / batonMode=false (default) 仍按原 depth check 走

### E2 (HIGH 配套文档)

- `schemas.ts:296` `START_NEXT_SESSION_SCHEMA` 注释更新 — 移除「+ 自动加入 plan-id team」旧语义（CHANGELOG_97 baton default 不加 team）+ 加 CHANGELOG_98 baton 不计 depth 说明
- `resources/claude-config/CLAUDE.md` K2 节加 batonMode callout：default batonMode 跳 depth check + setSpawnLink lateral，fan-out + rate 仍 enforce

### F1 (MED): A5 archived caller row missing 误报修

`start-next-session.ts:184-203` archive 前加 `sessionRepo.get(callerSid)` 探针 — caller row missing（异常被清理 / 边界状态）→ `archived='failed'` + warn + 不调 archive（旧实现 `archive()` 是 `setArchived` no-op + 仍返回 'ok' 误报）。三态语义清晰：'ok' 一种 / 'failed' 两种来源（row missing + archive throw）/ 'skipped' external caller。

### F2 (MED): 补单测覆盖 R2 fix 引入的新行为

- `start-next-session.test.ts`：现有 3 case 加 sessionRepo.get spy 让 caller-sid 有 row 走原 happy 路径 + 加 `archived` 三态字段断言；改写 1 case (caller 显式 cwd) 让其在 F1 探针调用下仍正确验证 mergeCallerCwd 优先 caller 显式；新增 1 F1 case 测 row missing 'failed' 路径
- `tools.test.ts`：wait_reply describe 新增 3 case：(a) nudge 触发 → ok return 含 `nudgeMessageIds` + `nudgesSent=1` (b) reply 给 originalId → 双查 originalId 路径命中 (c) reply 给 nudgeId → 双查 nudgeIds 路径命中（**核心反向场景**：B14 dormant + reviewer-codex MED2 实测 teammate 默认按 nudge wire prefix 抓 messageId reply nudgeId 而非 originalId，旧实现 lead 永等不到，本 case 验证修复后命中）；import eventBus 手动模拟 watcher emit 触发 listener

### F3 (MED): ~/.claude/CLAUDE.md §Step 2.5 触发节逻辑分组重组

R2 codex 发现「worktree clean」+「plan 已写好下一步」误归到「触发信号」（应该是**前置条件**，不是 agent 看到这两条就该 hand off）。

重组为：
- **触发信号**（≥1 条命中考虑 hand off）：context ≥ 60% / phase 完成 / 用户语义信号
- **前置条件**（2 条都必须满足）：worktree clean / plan 已写「下一会话第一步」+「当前进度」
- **触发命中但前置不满足**：先补齐前置（worktree dirty 先 commit / plan 不完整先写完）
- **特殊例外**：不可分割事务（typecheck / build / 单测在跑）/ user 明确说「先做完 X」→ 暂不 hand off

### F4 (LOW): 顺手 3 改

- `README.md L19` mcp__agent_deck__ 4 处 → mcp__agent-deck__ (R2 fix hyphen 对齐)
- `wait.ts:153-159` comment 改写澄清「race 实际已发生但无害」（reviewer-claude 现场验证 `enqueueAgentDeckMessage` 内同步 emit → onEnqueued → checkReply 跑完才 push nudgeId，是 race 但 reply 此刻不存在 onEnqueued 不命中 → 行为正确无害）
- `tools/index.ts:117` wait_reply description 加 `nudgeMessageIds` 字段 + 解释内部双查自动处理 + caller 可旁路 check_reply 自检
- (`schemas.ts:296` 已在 E2 一并改)

typecheck pass + 98 mcp test 全过（4 test files：12 spawn-guards + 13 archive-plan + 26 start-next-session + 47 tools，含 R2→R3 新增 8 case：spawn-guards +4 / start-next-session +1 / wait_reply +3）。

## R3 收口验证

R3 双 reviewer 复用 R2 mental model（active 状态 send_message，不必新 spawn）：
- **reviewer-claude R3** ✅ 「全部 R2 finding fix 对症 + 0 引新 bug + 可合（R3 收口）」（含实测 8-phase K2 baton 链 + fallback chain 各路径核查 + 6 个 focus 全过 + 反向断言印证）

## 已知踩坑（不阻塞本 PR）

- R2 *未验证* #1：codex `translate.test.ts:227` 用 `mcp__agent_deck__` underscore 是否反映 codex CLI 真实 server name — 跑实际 codex spawn 看 SessionDetail mcp tool name 形态确认是否需改（不在本 R3 scope）
- 'skipped' archived 状态实际不可达（denyExternalIfNotAllowed 已挡）：可加 invariant 注释或下次 review 决定是否从 schema 删 'skipped'
- B14 是「应用 CLAUDE.md 等级」核心反直觉踩坑：lead agent 看到 reviewer dormant **不要**等价为「fresh session 必须重 spawn」，dormant + send_message 自动 SDK resume 复原对话历史，mental model 通过 conversation history 隐式保留 ✅

## tally 候选（不升级）

- P34 候选 +1：「mcp baton 接力 spawn_depth 误判（fork-bomb 防御与 baton 单向交接语义错配）」
- U7 候选 +1：「dormant ≠ 丢 mental model（SDK resume 机制反直觉）」
