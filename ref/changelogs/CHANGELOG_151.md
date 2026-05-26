# CHANGELOG_151 — `handoff-no-spawn-guards-20260526` plan 收口:hand-off 完全独立于 spawn-guards / 永不写 spawn-link

## 概要

修用户反馈「hand off 出来的会话还是会被按照 lead/teammate 进行渲染」:`hand_off_session` 在 `archive_caller=false`(显式 opt-out) 路径下走 normal spawn 写 `spawn-link` → `SessionList` 把 caller 渲染为 lead、新 session 渲染为 teammate,违反 hand-off「不是派出小弟干活」设计意图。**plan §D4 用户原话「不进行任何和 spawn session 有关的检查」「都是平级的」**:hand-off 完全独立于 spawn-guards / 永不写 spawn-link,无论 `archive_caller` / `adopt_teammates` 值。**故意推翻 REVIEW_46/47 当年「`archive_caller=false` 退化 normal spawn」修法** — power-user 自负责任(plan §D3 + §D4)。

**RFC 3 轮 + Step 1.5 deep-review 3 轮**(R1: 12 finding 全采纳 / R2: 6 finding 全采纳 / R3: claude verify 0 真 MED 显式"可合" + codex re-spawn R1 全量 3 finding 全 inline 修订)收口。代码层 4 处改动(`spawn-link-guard.ts` / `spawn-guards.ts` / `spawn.ts` / `hand-off-session.ts`)+ 资产同步 5 处(`helpers.ts` / `schemas.ts` / 双份 prompt 资产 `resources/{claude,codex}-config/*.md` 注入 SDK system prompt)。**MCP 协议 breaking**:`spawn_session` handler `opts.batonMode` 改名 `opts.handOffMode` + 语义升级(原仅跳 spawn-guards depth check → 现跳全部三道防御 + 永不写 spawn-link;历史 REVIEW_39/46/47/48 出现的 `batonMode` 同义于现 `handOffMode`)。

## 变更内容

### Phase A — 代码层(4 文件)

- **改** `src/main/agent-deck-mcp/tools/handlers/spawn-link-guard.ts`:rename `ShouldWriteSpawnLinkOpts.batonMode` → `handOffMode`,逻辑不变(`handOffMode === true → false` 不写 spawn-link);jsdoc 整体重写明示 plan §D6 改名 + 语义升级 + REVIEW_39/46/47/48 历史名词同义
- **改** `src/main/agent-deck-mcp/spawn-guards.ts`:入参 `opts.batonMode` → `opts.handOffMode`;**三道全跳实现**(plan §D4 + R1 MED-6 + R2 LOW-3):
  - depth check `if (!opts?.handOffMode && parentDepth >= maxDepth)` 跳过
  - fan-out check 整段 `if (!opts?.handOffMode) { ... }` 包跳
  - spawn-rate check `if (!opts?.handOffMode && !spawnRateLimiter.tryConsume())` `&&` 短路求值 → token 不消耗
  - **`inFlightChildren.inc` 跳过**:`if (!opts?.handOffMode)` 包,hand-off 路径完全不进 in-flight 计数表;`fanOutSlot.release` 退化 no-op(没 inc 过 dec 也不必要)
- **改** `src/main/agent-deck-mcp/tools/handlers/spawn.ts`:opts 字段 rename + `applySpawnGuards` 调用入参 + `shouldWriteSpawnLink` 调用入参(L324 + L493 spawnDepth fallback)同步;jsdoc + 注释整段重写明示 plan §D1/§D6 hand-off 永不写 spawn-link 不论 archive_caller 值,故意推翻 REVIEW_46/47 修法
- **改** `src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts`:`resolveBatonRoleForSpawn` lambda 入参签名简化(删 `archive_caller` + `team_name`)→ `() => ({ handOffMode: true, batonRole: 'lead' })` 退化常量(plan §D8);handler 内调用改无参 + spawnFn 透传 `{ handOffMode: true, batonRole: 'lead' }`;jsdoc L226-256 整段重写明示推翻 REVIEW_46/47 修法 + plan §D5 `batonRole='lead'` 行为统一(无 archive_caller 分流)

### Phase B — 资产同步(5 处)

- **改** `src/main/agent-deck-mcp/tools/helpers.ts:122`:withMcpGuard wrapper jsdoc rename `opts?: { batonMode?: ...}` → `opts?: { handOffMode?: ...}`
- **改** `src/main/agent-deck-mcp/tools/schemas.ts:297-298`:CHANGELOG_98 注释整段重写明示 plan §D4/§D6 hand-off 完全跳过三道防御 + 永不写 spawn-link + 故意推翻 REVIEW_46/47
- **改** `resources/claude-config/CLAUDE.md:186`:整段重写删旧「baton 不计 spawn_depth(仅 archive_caller=true 时)」+「`archive_caller: false` 退化 normal spawn」+「防止 caller 用 opt-out 路径绕过 spawn_depth 限制开 N-phase fork-bomb」三段(注入 SDK system prompt 与 production 行为不一致是 caller 行为级 bug),改成 D4 决策「hand-off 完全独立于 spawn-guards / 永不写 spawn-link / `archive_caller` 与 spawn-guards 解耦 / power-user 滥用风险自负」
- **改** `resources/codex-config/CODEX_AGENTS.md:201`:同 claude 端做对偶更新(user CLAUDE.md §提示词资产维护 §约束 7 对偶资产同步硬约束)

### Phase C — 测试(6 文件 / 删 2 case + 整文件反转 1 + rename 4 + 新增 3 case)

- **改名 rename + 逻辑不变**(4 文件):
  - `__tests__/spawn-link-guard.test.ts` 3 case rename `batonMode` → `handOffMode`
  - `__tests__/spawn-guards.test.ts` 删 L106-130 旧 2 case(`batonMode=true 但 fan-out / rate 仍 enforce` — 与 D4 三道全跳直接矛盾)+ 其余 case rename + **新增 3 case**:`handOffMode=true caller depth>=max 仍通过`/`三道全跳`/`不进 in-flight 计数 + token 不消耗`
  - `__tests__/tools.test.ts` 3 处 `{ batonMode: true, ... }` 调用 rename + L941/998-1070 注释/用例名 rename + **新增 1 case** §不变量 9 边界(caller spawnDepth>0 + handOffMode=true → 新 session.spawnDepth=0 不累积)
  - `__tests__/hand-off-session.handler-deny-happy.test.ts` 1 处 `batonMode` → `handOffMode` 字段 rename + 用例名同步
- **整文件反转**(1 文件,plan §D7 R1 HIGH-3 修法):
  - `__tests__/hand-off-session.archive-caller-false.test.ts` — 旧文件意图就是验 REVIEW_46 B-HIGH-2 + REVIEW_47 M12 修法本身;plan §D4/§D5/§D6 故意推翻这两个修法 → 整文件 jsdoc 重写 + 4 lambda case + 4 handler case 断言全反转(所有 archive_caller 值都期望 `opts.handOffMode === true + opts.batonRole === 'lead'`)
- **新增 adopt opts 第三参覆盖**(1 文件,R3 codex LOW-2 修法):
  - `__tests__/hand-off-session.adopt-teammates.test.ts` `makeOkSpawn` 扩展捕第三参 opts;新增 1 case 验 `adopt_teammates: true → opts.handOffMode === true + opts.batonRole === 'lead'`(§不变量 7 hand-off 与 adopt 路径正交守门)

## 验证

- `pnpm typecheck` ✅(0 errors)
- `pnpm build` ✅(仅 1 dynamic-import warning rollup chunking 与本 plan 无关)
- `pnpm exec vitest run src/main/agent-deck-mcp/__tests__/`:**504/505 通过 + 2 skipped**;1 pre-existing baseline fail(`hand-off-session.impl-core.test.ts:332` REVIEW_33 H10 worktreePath fs 预检 — 本 plan 未动 hand-off-session-impl.ts,main repo 同款 fail,与本 plan 无关)
- 用户实测(Step 2.7):dev 启动 → 起一对 hand_off 链(`archive_caller=true` 默认 + `archive_caller=false` 显式)→ SessionList 看新 session 是 root 不缩进 / SessionCard 无 teammate chip / caller 无 lead chip

## Plan & Review reference

- Plan:[`plans/handoff-no-spawn-guards-20260526.md`](../plans/handoff-no-spawn-guards-20260526.md)
- 起源:用户反馈「hand off 出来的会话还是会被按照 lead/teammate 进行渲染」(同款消息含问题 1 SessionList 三层渲染 — 已 CHANGELOG_150 单独修)
- RFC:3 轮 AskUserQuestion 收 4 决策点 D1-D4 + follow-up D4 边界精确化(用户原话「都是平级的」+「不进行任何和 spawn session 有关的检查」)
- Step 1.5 deep-review 3 轮 fix loop:R1 12 finding 全采纳 / R2 6 finding 全采纳 / R3 4 finding 全 inline 修订 — reviewer-claude R3 显式「可合,进 Step 2 EnterWorktree」+ reviewer-codex re-spawn R1 全量 0 HIGH

## 推翻 REVIEW_46/47 明示

历史 REVIEW_46 B-HIGH-2 + REVIEW_47 M12 修法当年是为了防 caller 持 `archive_caller=false × N` 绕 fork-bomb 防御:让 `archive_caller=false` 退化 normal spawn 走完整 spawn-guards。本 plan §D4 用户决策**接受 power-user 自负责任**(D3:lead 起多 hand_off 处理子任务自己仍想看 reviewer reply / debug 工具用例是合法路径),故意推翻这两个修法 — 历史 REVIEW_39/46/47/48 出现的 `batonMode` 同义于现 `handOffMode`,语义升级(跳一道 → 跳三道 + 永不写 spawn-link)。

## 不变量(plan §不变量 9 项)

1. hand-off 是接力不是派活
2. spawn-guards 三道防御只服务 spawn 派活
3. archive_caller=false 是合法 power-user 路径
4. SessionList 视觉表达:hand-off 出来 session 完全独立 root
5. events.payload.handOff metadata 不变(CHANGELOG_145 已上)
6. spawn_session 公开 tool 行为不变(外部 mcp client 直接调仍走完整 spawn-guards + 写 spawn-link)
7. adopt_teammates: true 路径不受影响(swapLead 与 spawn-link / spawn-guards 正交)
8. batonRole='lead' 行为不变(原 M12 修法收口)
9. sessions.spawn_depth 默认 0(含 caller 是 spawn 派遣链节点 spawnDepth>0 边界 — by design hand-off 不继承 spawn 派遣 depth)
