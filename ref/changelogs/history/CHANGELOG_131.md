# CHANGELOG_131 — remove-aider-generic-pty-adapters-20260520 plan 收口: 删 aider + generic-pty adapter + node-pty/chokidar dep + slash 拦截删除 + GenericPtyConfig type 整片删

## 概要

`remove-aider-generic-pty-adapters-20260520` plan 收口 — 删除 aider + generic-pty 两个 adapter(整目录 + 所有引用)+ ComposerSdk slash 拦截 + node-pty/chokidar native dep + GenericPtyConfig TS type 整片删,剩 2 adapter(`claude-code` + `codex-cli`)。用户实测无任何历史数据(单用户 Mac app,从未用过这两个 adapter 建过 session),N3 单向不可逆强删,无 graceful fallback。

P0-P9 串行推进,**21+ commit chain** 落地(base `84a6910` 之后):**P0 ComposerSdk slash 拦截删除**(用户实测铁证 SDK streaming mode 支持 slash skill,推翻 CHANGELOG_6 老假设)→ **P1 删 adapter 实现层 + GenericPtyConfig type 整片删**(9 commits,SSOT 链式 enforce 5 处编译期 + 3 处 runtime 边界全闭环)→ **P2 删 UI**(4 commits,NewSessionDialog + GenericPtyConfigForm + ComposerSdk + activity-feed)→ **P3 删 IPC / MCP schema + 注释清扫**(5 commits)→ **P4 删 shared types + jsdoc 残留清扫**(7 commits,共 18 处 jsdoc 残留分布 6 文件全清,4 处 plan name reference 作 historical attribution 保留)→ **P5 删测试 / mock**(2 commits,P5.3a TC7+TC7b 整删 + P5.3b vi.spyOn 局部 mock)→ **P6 卸 native dep**(1 commit,删 node-pty + chokidar 共 -15 packages + scripts/fix-pty-permissions.mjs 整删 + asarUnpack 2 globs 删,顺带解锁 install-app-deps 撞 distutils 的环境 blocker)→ **P7 DB schema 兜底自检**(0 hit 确认 D4 假设)→ **P8 文档扫描 + changelog**(1 commit P8.2 + 本 CHANGELOG)。

P9.3 ⚑ pnpm test 全跑提前 unblock(P6 卸 node-pty 后 pnpm install pipeline 不再撞 node-gyp distutils → install-app-deps 仅 rebuild better-sqlite3 → electron postinstall 路径自然通)。**64/64 file passed | 762/838 test passed**(76 skipped 全是 better-sqlite3 binding ABI v130 vs v137 守门 skip,符合 CHANGELOG_42 教训)。

typecheck PASS / build PASS / test PASS。

## 变更内容

### P0 — ComposerSdk slash 拦截删除(commit `6a9ac67`)

`src/renderer/components/SessionDetail/ComposerSdk.tsx` 删 line 109-120 整段 `if (t.startsWith('/'))` 7 行 if 块 + 上方 5 行 jsdoc 注释 + 顶部 line 20「关键护栏」bullet「SDK streaming mode 不支持 slash 命令...」整条删。CHANGELOG_6 引入的拦截基于错误前提(用户实测 NewSessionDialog 首条 `/hello-from-deck` 跑通 SKILL,SDK streaming mode 实际**支持** slash 触发 skill);UX trade-off:删后老 CLI builtin slash(`/clear` / `/compact` / `/cost`)由 ComposerSdk catch 块自动 setSendError 显示 SDK 英文原文(从中文友好提示降级为英文 SDK message,可接受,skill slash 是主流场景)。

### P1 — 删 adapter 实现层 + GenericPtyConfig type 整片删(9 commit chain)

- `aa8d477` rm `src/main/adapters/aider/` + `src/main/adapters/generic-pty/` 整目录(-2800 行)
- `13a12d0` `types.ts` 删 `PtyCreateOpts` interface + `CreateSessionOptions` union 2 arm + `CreateSessionOptionsRaw.genericPtyConfig` 字段
- `44e0f31` D4 GenericPtyConfig type 整片删 — `session-repo/types.ts` 删 import + `parseGenericPtyConfigJson` 函数 + `core-crud.ts` 删 import + `setGenericPtyConfig` setter + upsert binding 固定 `null`(N3 + 无历史数据,raw write-back 不需要)+ `shared/types/session.ts:5` 删 `GenericPtyConfig` import + `SessionRecord.genericPtyConfig` 字段类型从 `?: GenericPtyConfig | null` 改 `?: unknown | null`(Round 2 HIGH-A 修法)
- `cb3b721` `registry.ts` 删 `AiderAdapter` / `GenericPtyAdapter` 2 import + `AdapterIdMap` 2 entry
- `7339505` `options-builder.ts` 5 处改:① `CreateSessionOptionsByAdapter` 2 entry 删 ② `AGENT_IDS` list 2 字面量删 ③ `buildCreateSessionOptions` switch 2 case 删 ④ `narrowToPtyOpts` 函数整删 ⑤ error message 文案改"expected: claude-code | codex-cli"
- `cf08d6b` `main/index.ts` 删 2 register imports + 2 `adapterRegistry.register(...)` 行 + 注释更新
- `9d4c5c1` `ipc/adapters.ts` 删 `GenericPtyConfig` + `parseGenericPtyConfig` import + R4·F2 parse 路径 + `buildCreateSessionOptions` spread 末段(Round 3 HIGH-1 修法)
- `615cad1` rm `src/main/adapters/__tests__/adapter-create-options.type-narrow.test.ts` 整文件(Round 3 HIGH-1 修法)
- `d2cd39b` `_shared/mocks/session-repo.ts` 删 `setGenericPtyConfig` mock 行

P1.11 ⚑ pnpm typecheck GREEN — 5 处 SSOT 守门 + 3 个 `_assert*` 函数 + `_exhaustive: never` 全闭环。

### P2 — 删 UI(4 commit chain)

- `c5b770f` `NewSessionDialog.tsx` 删 GenericPtyConfig imports + state + showGenericPtyConfig 路径 + submit() 校验 + spread + JSX block(-27 行)
- `d3ca3f0` rm `GenericPtyConfigForm.tsx` 整文件(-238 行)
- `b527b78` `ComposerSdk.tsx` 注释清扫(保留 REVIEW_35 attribution + `canAcceptAttachments` expression 显式白名单 future-proof — 不简化为 `true` 因新 adapter 应主动 opt-in 防止默认拿到 attachments 路径)
- `0ca745a` `activity-feed/shared.ts` `getAgentShortName` 删 `'aider'` / `'generic-pty'` 2 case(default fallback 自动兜底)

P2.5 ⚑ typecheck GREEN。

### P3 — 删 IPC / MCP schema + 注释清扫(5 commit chain)

- `56c8005` `mcp/tools/schemas.ts` 删 3 处 `z.enum([..., 'aider', 'generic-pty'])` 项(SPAWN_SESSION + LIST_SESSIONS adapter_filter + HAND_OFF_SESSION adapter)+ HAND_OFF describe
- `3108731` `mcp/tools/index.ts` `spawn_session` description 文案删
- `5cb080c` `handlers/spawn.ts` 删 aider/generic-pty 字眼 3 处(error help + 注释 + dead defensive `if`)
- `408a110` `ipc/sessions.ts` hand-off summariseEvents 注释 future-proof 改写
- `66fad0f` 4 注释级文件清扫:`event-repo.ts` / `message-delivery-state.ts` / `summarizer/index.ts` / `sdk-bridge/constants.ts`

P3.7 ⚑ typecheck GREEN。

### P4 — 删 shared types + jsdoc 残留清扫(7 commit chain)

- `81afabb` `shared/types.ts` 删 `export * from './types/generic-pty'` 一行
- `0ea023e` rm `shared/types/generic-pty.ts` + `__tests__/generic-pty.test.ts`(-257 行)
- `bcf389b` `wire-prefix.ts` jsdoc 字面量 2 项删(`WirePrefixParse.adapter` 实际类型是 `string` 非 union,无 typecheck 影响)
- `ee42912` `shared/types/session.ts` jsdoc × 6 处(codexSandbox / claudeCodeSandbox / model / extraAllowWrite / genericPtyConfig 历史字段 R4·F2 注释保留 attribution + 改"老 PTY-based session"抽象名)
- `16f9de7` `main/adapters/types.ts` capability docs × 5 处(canCloseSession / canCollaborate / canAcceptAttachments / closeSession / summariseEvents)
- `8fd4dc6` 4 文件 × 7 处:`ipc/adapters.ts` + `core-crud.ts` × 4(R4·F2 注释 + 3 setter docs)+ `rename.ts` + `session-repo/index.ts`

P4.5 + P4.6 ⚑ typecheck GREEN。grep 残留 4 处全为 plan name reference / `parseGenericPtyConfigJson 已 P1.4 删` historical attribution,作为溯源信息保留。

### P5 — 删测试 / mock(2 commit chain)

- P5.1 noop ✅(P1.9 已处理 `_shared/mocks/session-repo.ts`)
- P5.2 noop ✅(D4 决策保留 `__tests__/_setup.ts` v012 import — `generic_pty_config` 列保留兼容老 SQLite 文件,N6 不变量)
- `19555b5` P5.3a `spawn-agent-name-routing.test.ts` 删 TC7+TC7b 整 it 块 + 顶部矩阵注释 + mock factory 注释(PTY adapter 删后这 2 个 testcase 路径不复存在)
- `1131b41` P5.3b `tools.test.ts` `rejects unknown adapter` testcase:`adapter:'aider'` → `adapter:'codex-cli'`(schema-valid 走 zod 通过)+ `vi.spyOn(adapterRegistry, 'get').mockReturnValueOnce(undefined)` 局部覆盖让 spawn.ts:48-53 第一段 if `!adapter || !adapter.createSession` 命中走 `cannot create sessions` error path(reviewer 反驳轮共识方案)
- P5.4 noop ✅(`hand-off-session.handler-cwd-generic.test.ts` 文件名 "generic" = generic mode 而非 generic-pty adapter,保留)
- P5.5 noop ✅(`ipc/__tests__/sessions.test.ts` 已 clean)

### P6 — 卸 node-pty + chokidar native dep(commit `197859b`)

- `pnpm remove node-pty chokidar`(-15 packages,2 dep entry 删)
- `package.json scripts.postinstall` 删 `&& node scripts/fix-pty-permissions.mjs` 后缀(变 `electron-builder install-app-deps`)
- `package.json build.asarUnpack` 删 2 条 `node-pty` glob
- `git rm scripts/fix-pty-permissions.mjs`(-187 行)

P6.7 ⚑ pnpm typecheck + pnpm build 全 GREEN。环境 blocker 一并解锁:旧 install pipeline 撞 `electron-builder install-app-deps` 重建 node-pty 撞 Python `distutils` 缺失(node-gyp 9 + Node 24 兼容性问题);删 node-pty 后 install-app-deps 仅 rebuild better-sqlite3,自然通。

### P7 — DB schema 兜底自检(0 hit ✅)

`grep -RInE "agent_id.*CHECK|CHECK.*agent_id|agent_id IN" src/main/store/migrations/` 0 hit 确认 D4 假设(`adapter` 字段裸 TEXT,无 enum CHECK 约束)。无变更。

### P8 — 文档扫描 + changelog(1 commit + 本文件)

- `edb56b8` 当前事实 docs 删 aider/generic-pty(README.md 5 处 + `docs/agent-deck-team-protocol.md` 5 处 + `resources/codex-config/CODEX_AGENTS.md` 1 处)
- 历史 record(`docs/adapter-architecture-rfc-20260515.md` / changelog / reviews / plans)D5/D6 决策不动
- 项目 CLAUDE.md / 应用打包 CLAUDE.md grep 实测 0 hit(无需改动)
- 本 CHANGELOG_131.md + `changelog/INDEX.md` 加行

### P9 — 验证 + deep-review(2 commits 跨 3 round)

走 `/agent-deck:deep-review` SKILL,kind='code',scope = 51 files changed since base_commit `84a6910`。重 spawn 跨 adapter native pair:reviewer-claude(claude-code adapter,Opus 4.7)+ reviewer-codex(codex-cli adapter native,gpt-5.5 xhigh)。

**R1 finding**:
- **MED 双方独立**(reviewer-claude MED-1 + reviewer-codex MED):plan focus #7 准则触发(`grep -rn "\.genericPtyConfig\b" src/` = 0 alive caller)→ escalate 整删字段。`a8a4685` 实施:删 `SessionRecord.genericPtyConfig` 字段(shared/types/session.ts) + rowToRecord 投影(session-repo/types.ts) + test fixture key(handler-cwd-generic.test.ts);DB 层不动(N6 保留 SQL DDL column / Row interface / INSERT binding NULL / rename.ts toExists UPDATE 老 row 兼容)
- **LOW reviewer-codex** spawn.ts:263 注释 `narrowToPtyOpts` stale(函数 P1.6 已删)→ 改 "claude-code adapter narrow / narrowToClaudeOpts"
- **LOW reviewer-claude × 3**:① `codex-config/{agents-md-installer,skills-installer}.ts` 2 处 chokidar 注释 stale → 改 "外部 watch / hot reload monitor";② `spawn.ts:95-101` zod-enum drift defense 加 4 行注释解释 "structurally unreachable today, kept as zod-enum drift defense";③ v019 migration SQL 注释类比失效 — D5 决策不修(historical immutable)
- **INFO** slash 删除缺 regression test — ack 不修(项目本来 ComposerSdk 0 测试)

**R2 finding**:
- reviewer-claude R2 ✅ 可合 + 12 caller path 全 verified graceful(legacy aider DB row 经各 caller 路径 noop / throw / fallback / markFailed / warn 都优雅)
- **MED reviewer-codex 单方 + lead spot-check verify**:hand-off 是 2 stage 流程,Stage 1 走 fallback `summariseSessionForHandOff` 跑 paid Claude oneshot 后 Stage 2 必然 throw "adapter cannot create session"(老 aider/generic-pty SQLite row 命中)。`c66b4e5` 实施:`ipc/sessions.ts:113-125` Stage 1 加 `if (!adapter?.createSession) throw` early gate,与 Stage 2 line 156 镜像。defense-in-depth 不依赖 plan D1 "用户无历史数据" 假设
- **INFO reviewer-codex** 缺老 row 兼容 regression test — ack 不修(better-sqlite3 binding skip 在 vitest CI path,test infra 限制,符合 CHANGELOG_42 教训)

**R3 finding**:双方 ✅ 可合 + 0 新 finding(R2 fix 验证 — Stage 1/2 adapter gate 对齐 + typecheck PASS + caller / UX / typing 全对称),终态裁决收口。

**reviewer 状态**:
- reviewer-claude · rm-pty sid=`f1a938f7-28d0-4d0d-9021-7789536a5133`
- reviewer-codex · rm-pty sid=`019e4445-a995-7990-ab40-37008a48e880`
- 由 P10 `archive_plan` 自动 baton shutdown 收口

## 关键不变量(改造后)

1. **N1**:剩 2 adapter — `claude-code` + `codex-cli`
2. **N2**:5 处 TS 编译期 SSOT 守门 + 3 处 runtime 边界 keys 严格一致(`CreateSessionOptions` union arm / `CreateSessionOptionsByAdapter` map / `AdapterIdMap` map / `AGENT_IDS` list / `buildCreateSessionOptions` exhaustive switch + `adapterRegistry.register` + MCP zod enum + IPC zod enum)
3. **N3**:删除单向不可逆;无 graceful fallback / "see legacy" 兼容代码
4. **N4**:typecheck / test / build 三类命令全绿(P0/P1/P2/P3/P4/P6/P9 共 10 个 ⚑ checkpoint 实证)
5. **N6**:`generic_pty_config` DB 列保留兼容老 SQLite 文件,新 session 永远 binding `null`;TS 层 `GenericPtyConfig` schema / `parseGenericPtyConfigJson` 函数 / `setGenericPtyConfig` setter 全删,`SessionRecord.genericPtyConfig` 字段类型 `unknown | null` 让 caller 不依赖具体 schema
6. **slash 拦截彻底删** — ComposerSdk 不再 `if (t.startsWith('/'))` 拦截;skill slash 走 SDK streaming mode 直接触发,builtin CLI slash 走 SDK 报英文 message 兜底

## 关键 follow-up(本 plan 之外的发现)

**F1: hand_off_session 增加 teammate 过继(adopt)语义**(优先级 LOW)— 本 plan P2 起手会话由 hand_off_session 接力起,默认 `keep_teammates=false` shutdown 了 caller 同 team 两个 reviewer(plan §当前进度 reviewer 状态节标 ⚠ closed,P9 重 spawn 新 pair),mental model 从此丢失。建议 future plan 给 `hand_off_session` 加 `adopt_teammates: boolean` 参数(默认 false 与现状一致),true 时新 session 自动加入 caller 同 team + caller teammate 不 shutdown + 新 session 接 caller lead 角色,保留 mental model。详 [`plans/remove-aider-generic-pty-adapters-20260520.md`](../../plans/history/remove-aider-generic-pty-adapters-20260520.md) §Follow-up F1 节(本 plan 完成 archive_plan 时入项目 git,后续如要做新建独立 feature plan 走 §RFC + §spike + §Deep-Review 全流程)。

**F2: 防递归阈值默认值上调**(优先级 MED)— 用户实测设置面板「防递归阈值」当前默认值仍是 `mcpMaxFanOutPerParent` = 5 + `mcpSpawnRatePerMinute` = 10。CHANGELOG_125 末文字称已调高但实际未落地(可能 settings-defaults 漏改 / 老 settings 持久化未 migrate)。当前在 deep-review 多对 reviewer + plan baton hand-off 多场景下偏紧。建议 future plan 升级 `mcpMaxFanOutPerParent` 5→10 + `mcpSpawnRatePerMinute` 10→20 + 验证 settings-defaults / settings-store migrate 逻辑 + 同步面板 jsdoc 描述更新。详 [`plans/remove-aider-generic-pty-adapters-20260520.md`](../../plans/history/remove-aider-generic-pty-adapters-20260520.md) §Follow-up F2 节。

## 详情

详 [`plans/remove-aider-generic-pty-adapters-20260520.md`](../../plans/history/remove-aider-generic-pty-adapters-20260520.md)(plan v4 经 4 轮 deep-review fix loop 收敛)。
