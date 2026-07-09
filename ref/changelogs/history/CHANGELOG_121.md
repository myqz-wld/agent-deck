# CHANGELOG_121 — RFC §1 Option D2 落地：CreateSessionOptions 拆判别联合 + typed registry binding

## 概要

`p4-baseadapter-d2-implement-20260515` plan 收口（RFC §1 Chapter 1 sign-off Option D2 实施）—— 把 `CreateSessionOptions` 单宽 interface 拆为 4 union arm + 4 interface（`ClaudeCreateOpts` / `CodexCreateOpts` / `PtyCreateOpts` × 2 共享）+ `agentId` 字段判别联合 + `buildCreateSessionOptions` builder helper exhaustive switch + 4 adapter typed export，让 caller 端 TS 编译期阻止字段误传（如 `codexSandbox` 给 claude adapter / `permissionMode` 给 codex adapter）+ caller 端直接 import 拿 typed instance 暴露 adapter-专属方法。

R1 reviewer-claude Y / reviewer-codex N（守门只单侧），R2 lead 修 F2 cosmetic + F3 4 处 SSOT 守门 → reviewer-claude Y + 1 LOW 注释孤儿 / reviewer-codex N + 1 MED isAgentId 手写白名单未 SSOT 守门，R3 lead 修 F4 抽 AGENT_IDS as const SSOT 驱动 + 守门 (5) + F5 修注释 → 双方 R3 收口 Y。3 轮异构对抗 review × fix × 反驳轮共 4 处真 finding 全 fix（除 F1 plan stub 文档延后到本归档阶段）。

## 变更内容

### Phase 1 类型层（commit `ebefdfb`）

- **`src/main/adapters/types.ts`** 拆 4 interface（每个 interface 自身可读完整字段集 + adapter-specific jsdoc）+ 判别联合 `CreateSessionOptions` + `CreateSessionOptionsRaw`（builder 输入 caller 不挑 adapter 透传所有字段）
  - **ClaudeCreateOpts**：cwd / prompt / permissionMode / resume / teamName / attachments / model / claudeCodeSandbox / extraAllowWrite（9 字段）
  - **CodexCreateOpts**：cwd / prompt / resume / teamName / attachments / model / codexSandbox / extraAllowWrite（8 字段，**不**含 permissionMode / claudeCodeSandbox）
  - **PtyCreateOpts** (aider + generic-pty 共享)：cwd / prompt / teamName / attachments / genericPtyConfig（5 字段，**不**含 resume / model / sandbox / extraAllowWrite — PTY 没有这些概念）
  - 删 dead `systemPrompt` 字段（claude-code/index.ts 旧 inline opts 注释 dead reference，grep 验证 0 caller 透传 + 0 sdk-bridge 消费）
- **`src/main/adapters/options-builder.ts`**（新增）：`buildCreateSessionOptions` exhaustive switch + `narrowToClaudeOpts/narrowToCodexOpts/narrowToPtyOpts` filter 函数 + `isAgentId` runtime guard + typed/string overload signature（typed overload 给已 narrow caller / string overload 给 dynamic agentId caller 走内部 isAgentId guard）
- **`src/main/adapters/registry.ts`** 加 `AdapterIdMap` typed export；保留 string-only `get(id)` overload 兜底（typed overload 在 enum union arg 时撞 union dispatch fail，详 registry.ts 内注释；caller 想拿 typed instance 直接 import `claudeCodeAdapter` 等绕过 registry）
- **4 adapter index.ts**：inline opts type 改 narrow union arm（如 claude-code 的 `ClaudeCreateOpts & { agentId: 'claude-code' }`）+ class rename `XAdapterImpl → XAdapter` + typed export（`claudeCodeAdapter: ClaudeCodeAdapter` 等）

### Phase 2 caller migration（commit `ebefdfb`）

5 处生产 caller + 1 处 helper 全部 migration 用 `buildCreateSessionOptions` builder helper 按 agentId narrow opts:
- **`src/main/agent-deck-mcp/tools/handlers/spawn.ts:230`**（MCP spawn 入口）
- **`src/main/cli.ts:268`**（CLI lead path）+ **`src/main/cli.ts:315`**（CLI member path）
- **`src/main/ipc/adapters.ts:174`**（IPC AdapterCreateSession handler，`parseStringId('agentId', ...)` 拿 `validAgentId` 后塞 builder）
- **`src/main/ipc/sessions-hand-off-helper.ts:25`**（**RFC §1.5 漏列的第 6 处 caller helper** — 性质同 spawn.ts:236 omitUndefined helper，计入 caller migration 范围；H6 sandbox 透传链 REVIEW_33 通过 `session.codexSandbox / claudeCodeSandbox` → builder 按 session.agentId narrow filter 到对应 arm 自动保留）

### Phase 4 测试 + 异构对抗 review（commit `ebefdfb` test + `8a15a6f` R1 fix + `ad221de` R2 fix）

- **`src/main/adapters/__tests__/adapter-create-options.type-narrow.test.ts`**（新增）18 tests:
  - runtime narrow 行为（claude / codex / aider / generic-pty 各 narrow 后 filter 跨 adapter 字段）
  - 6 个 `@ts-expect-error` 编译期约束（claude 误传 codexSandbox / codex 误传 permissionMode 等，typecheck 跑时 expected 行 TS 必须真报错否则 typecheck 报「Unused @ts-expect-error directive」）
  - typed adapter export runtime 验 id + adapter-专属方法可见
- **`src/main/ipc/__tests__/sessions.test.ts`** 6 case 改造:每个期望加 `agentId` 字段（builder 自动塞）+ 跨 adapter 字段 access 用 `Extract<CreateSessionOptions, { agentId }>` cast narrow + 「全字段都设」test 拆成 claude / codex 两 test 独立验证 D2 narrow filter 行为
- **`src/main/adapters/generic-pty/__tests__/adapter.test.ts`** fixture 加 agentId 字段

### R1 review fix（commit `8a15a6f`）

- **F2 (reviewer-claude MED 单方)**：`claude-code/index.ts:74` 改成显式 spread 9 字段（与 codex/aider/generic-pty 风格一致）— 不再透 D2 discriminator agentId 字段给 bridge（bridge structural typing 当前接受但 future strict check 会破）
- **F3 (reviewer-codex MED 单方)**：4 处 SSOT 守门 — 加 `AssertSameKeys<A, B>` type-level trick（双向 keyof extends），让 types ↔ builder ↔ registry 三处真 TS 编译期强守门：
  - 守门 (3) `_assertOptionsByAdapterMatchesUnion`（options-builder.ts）：CreateSessionOptionsByAdapter keys ↔ CreateSessionOptions union arm agentId literals
  - 守门 (4) `_assertAdapterIdMapMatchesOptions`（registry.ts）：AdapterIdMap keys ↔ CreateSessionOptionsByAdapter keys
  - 守门 (1)/(2) 已有（types union arm 漏 → narrowToXOpts return 类型不匹配；switch case 漏 → `_exhaustive: never`）
- 实测验证：临时漏 `AdapterIdMap.aider` → TS 报错 `Type 'true' is not assignable to type 'false'.` 行 43；同款临时漏 `CreateSessionOptionsByAdapter.aider` → 报错 + switch case `Type '"aider"' is not comparable to type 'keyof CreateSessionOptionsByAdapter'.`

### R2 review fix（commit `ad221de`）

- **F4 (reviewer-codex R2 MED 单方)**：抽 `AGENT_IDS as const` 一份 SSOT list 同时驱动 `AgentId` type union（`(typeof AGENT_IDS)[number]`）+ `isAgentId()` runtime guard（`AGENT_IDS.includes(value)`），消除「类型 union ↔ runtime guard」双源漂移；加守门 (5) `_assertAgentIdsListMatchesOptions`（同款 AssertSameKeys trick）让 AGENT_IDS list ↔ ByAdapter keys 严格双向一致。修前：加新 adapter 漏改 isAgentId 字面量列表 → TS 0 error → runtime string overload guard 拒绝 → 用户体感「明明 4 处 SSOT 都改了，但 spawn 新 adapter 还是 throw 'unknown agentId'」。
- **F5 (reviewer-claude R2 LOW 单方)**：注释表 (1) 行从孤儿引用 `_assertCreateSessionUnionConsistent` 改为 `_assertOptionsByAdapterMatchesUnion`（同 (3)，双向覆盖 union arm ⇆ ByAdapter entry 一致性）
- 实测验证：临时漏 `AGENT_IDS.aider` 一项 → TS 报 2 个 error（switch case 缺 'aider' 走 default `_exhaustive: never` + 守门 (5) `_assertAgentIdsListMatchesOptions` 触发）

## 加新 adapter 现状

主链 **5 处 TS 编译期强守门**（漏改任一 TS 报错）:
1. `types.ts` `CreateSessionOptions` union 加 arm
2. `options-builder.ts` switch case + `narrowToXOpts` 函数
3. `options-builder.ts` `CreateSessionOptionsByAdapter` 加 entry
4. `registry.ts` `AdapterIdMap` 加 entry
5. `options-builder.ts` `AGENT_IDS` list 加 entry（同时驱动 AgentId type + isAgentId runtime guard）

runtime 边界 **3 处流程检查**（TS 类型层无法守门，commit message + plan checklist + 集成测试覆盖）:
6. `main/index.ts` `adapterRegistry.register(<NewAdapter>)`
7. `agent-deck-mcp/tools/schemas.ts` `SpawnSessionArgs.adapter` zod enum / IPC schema enum
8. `cli.ts` `parseCliInvocation` enum 校验

## 跳过项

- **Phase 3 Option C `delegateOrThrow` helper**：RFC §1.3 自评收益小（仅 4 adapter 各省 5-8 行 boilerplate）+ 当前 adapter lifecycle 方法行为不一致（有 throw 有 return）需独立 plan 决定一致行为后再收口。本 plan 不做。
- **REVIEW_X.md 单建**：plan 5.1 阈值（≥ 2 HIGH finding）未到 — R1+R2+R3 累积 0 HIGH（4 个 MED + 2 个 LOW），本 CHANGELOG cover review process 摘要已足够。

## 已知 plan stub 偏差

**Step 1.1 stub「typecheck 应零变化」错误断言**：实际拆 union arm 后 caller 必塞 agentId，typecheck 必 break；Step 2.1 caller migration 用 builder helper 自动塞 agentId 才恢复 0 error。改 commit 策略 Phase 1+2 合并到同 commit chain（typecheck always green）。本归档阶段统一回写 plan 文件「下一会话第一步」+ Step 1.1 断言。

## 验证

- `pnpm typecheck`（main + web）：全过零 error（包含新 type-level guards `_assertOptionsByAdapterMatchesUnion` + `_assertAdapterIdMapMatchesOptions` + `_assertAgentIdsListMatchesOptions`）
- `pnpm exec vitest run`：596 tests passed / 64 skipped（skip 是 better-sqlite3 binding ABI worktree 环境特有，与 D2 无关；项目 CLAUDE.md 已知）
- 新加 `adapter-create-options.type-narrow.test.ts` 18 tests 全过 + 6 `@ts-expect-error` 全 trigger
- 反向漏改实测：临时漏 AdapterIdMap.aider / CreateSessionOptionsByAdapter.aider / AGENT_IDS.aider 任一 → TS 编译期报错（守门链兑现 reviewer-codex 提的核心承诺）

## Touchpoint

| Phase | 文件 | LOC |
|---|---|---|
| Phase 1 类型层 | types.ts +151/-100 / options-builder.ts +159/-0(NEW) / registry.ts +27/-0 / 4 adapter +25/-75 | +362/-175 |
| Phase 2 caller | spawn / cli×2 / ipc/adapters / sessions-hand-off-helper | +52/-39 |
| Phase 4 测试 | adapter-create-options.type-narrow.test.ts +295(NEW) / sessions.test.ts +43/-19 / adapter.test.ts +2/-2 | +340/-21 |
| R1 fix | claude-code/index.ts +13/-1 / options-builder +47/-0 (守门 3 + 注释表) / registry.ts +27/-3 (守门 4) | +87/-4 |
| R2 fix | options-builder.ts +42/-15 (AGENT_IDS list + isAgentId 改 list 驱动 + 守门 5 + 修注释) | +42/-15 |
| **总计** | 14 文件改 + 2 新建 | **~+880/-254** |

实测略高于 RFC §1.5 估 +165/-140 — 主要超出在新单测 + builder helper 内嵌注释 + R1+R2 守门补强（reviewer 指出后增的）。

## 引用

- Plan: [`plans/p4-baseadapter-d2-implement-20260515.md`](../../plans/history/p4-baseadapter-d2-implement-20260515.md)
- 父 RFC: `adapter-architecture-rfc-20260515` Chapter 1（见父 plan）
- 父 plan: [`plans/adapter-architecture-design-20260515.md`](../../plans/history/adapter-architecture-design-20260515.md) (RFC stub 收口) → CHANGELOG_120
- 触发: [REVIEW_40.md](../../reviews/history/REVIEW_40.md) follow-up P2 architectural design questions
