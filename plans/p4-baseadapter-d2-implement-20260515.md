---
plan_id: "p4-baseadapter-d2-implement-20260515"
created_at: "2026-05-15"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/p4-baseadapter-d2-implement-20260515"
status: "completed"
base_commit: "a6dbbe07a3ffb35f41c6f04eb444e4446fab33c3"
base_branch: "main"
parent_rfc_id: "adapter-architecture-rfc-20260515"
parent_rfc_chapter: "1"
parent_plan_id: "adapter-architecture-design-20260515"
final_commit: "47d6f6422e75b351d7c29071d7dfb0f6f429da1d"
completed_at: "2026-05-15"
---

# p4-baseadapter-d2-implement-20260515 — RFC §1 Option D2 实施(CreateSessionOptions 拆判别联合 + typed registry binding)

## 总目标 & 不变量

按 `docs/adapter-architecture-rfc-20260515.md` Chapter 1 「Option D2(D + typed registry binding)」决策实施 — RFC 已 user sign-off accepted。

**不变量**:
- **决策不再争论**:option 取舍已在 RFC §1.4 sign-off,本 plan 仅实施。任何想推翻 D2(改用 D / A / B)的提议必须先回 RFC 阶段重起 design plan
- **caller migration 一次性集中**:5 处生产 caller 同 PR 收口(spawn.ts:230 / cli.ts:268+315 / ipc/adapters.ts:174 / ipc/sessions.ts:133),不留半改半留状态
- **可选 Option C(`delegateOrThrow` helper)** 顺手做或留独立 followup 都行,**默认顺手做**(零结构变更)
- **typecheck + 全单测一遍 + 异构对抗 review** 是合并门禁

**RFC 决策摘要**(详 RFC §1.3-1.8):
- 拆 `CreateSessionOptions` 为 4 union arm + 4 interface(`ClaudeCreateOpts` / `CodexCreateOpts` / `PtyCreateOpts` × 2 共享)
- typed registry overload + `buildCreateSessionOptions` builder helper + exhaustive switch(加新 adapter 漏 arm TS 编译期报错)
- 5 处生产 caller 改 typed registry binding,caller 端 TS 自动 narrow 拿到具体 adapter 实例
- adapter 实例命名 export class type(`claudeCodeAdapter: ClaudeCodeAdapter` 替换 `: AgentAdapter`)
- 预估 ~+165 / -140 行(详 RFC §1.5)

## 设计决策(不再争论)

详 `docs/adapter-architecture-rfc-20260515.md` §1.3 (Option D2 完整 typescript snippet) + §1.4 (推荐) + §1.5 (touchpoint estimate) + §1.8 (迁移路线 Step 0-5)。本 plan 不复述,实施时直接读 RFC。

**关键决策点不再争论**:
- 不退到 D 单独(D 不解决 caller 端 TS 实例类型 binding,R1 双方独立指出)
- 不退到 A(抽象基类)— RFC §1.4 已 ack 仅治 30 行 boilerplate 收益小
- 不退到 B(mixin)— RFC §1.4 已 ack 函数式组合在 TS 类型推导上易踩 generic 推断陷阱

## 步骤 checklist

> RFC §1.8 迁移路线 Step 0 是「等 parity-plan Phase A+B 收尾」前置约束 — **已满足**(`cross-adapter-parity-20260515.md` 已 status=completed,final_commit=`78c0ef9`,完成于 2026-05-15)。Step 1 起本 plan 接力。

### Phase 1: 类型层拆判别联合 + builder helper

- [x] **Step 1.1 — `adapters/types.ts` 拆 4 interface + 判别联合** — 完成 by p4-d2-impl-20260515 (commit `ebefdfb`)
  - 拆为 `ClaudeCreateOpts` / `CodexCreateOpts` / `PtyCreateOpts`(aider+generic-pty 共享) + 判别联合 `agentId: 'claude-code' | 'codex-cli' | 'aider' | 'generic-pty'` + `CreateSessionOptionsRaw`(builder 输入 caller 不挑 adapter 透传所有字段)
  - 各 adapter `index.ts` 内 inline opts type 改引用对应 interface(机械)+ 删 dead `systemPrompt` 字段(grep 验证 0 caller 透传 + 0 sdk-bridge 消费)
  - **⚠️ stub 断言修正**:原写「typecheck 应零变化」**错误** — 拆 union arm 加 `agentId` 判别字段后,5 处生产 caller 必缺该字段 → typecheck 必 break;Step 2.1 caller migration 用 builder helper 自动塞 agentId 才恢复 0 error。改 commit 策略 Phase 1+2 合并到同 commit chain(typecheck always green)

- [x] **Step 1.2 — typed registry overload + `buildCreateSessionOptions` builder helper** — 完成 by p4-d2-impl-20260515 (commit `ebefdfb`)
  - `adapters/registry.ts` 加 `AdapterIdMap` typed export;**保留 string-only `get(id)` overload 兜底**(原计划 typed overload 在 enum union arg 时撞 union dispatch fail 已退化,详 registry.ts 内注释;caller 想拿 typed instance 直接 import `claudeCodeAdapter` 等绕过 registry)
  - `adapters/options-builder.ts`(新建)实装 `buildCreateSessionOptions<T>(agentId, raw)` exhaustive switch + `narrowToClaudeOpts/narrowToCodexOpts/narrowToPtyOpts` filter + `isAgentId` runtime guard + typed/string overload signature
  - 各 adapter `index.ts` 改 typed export(`export const claudeCodeAdapter: ClaudeCodeAdapter` 替换 `: AgentAdapter`,需先 export class type)+ class rename `XAdapterImpl → XAdapter`

### Phase 2: caller migration

- [x] **Step 2.1 — 5 处生产 caller 改 buildCreateSessionOptions** — 完成 by p4-d2-impl-20260515 (commit `ebefdfb`)
  - `agent-deck-mcp/tools/handlers/spawn.ts:230`(主入口)
  - `cli.ts:268` + `cli.ts:315`(CLI 两处)
  - `ipc/adapters.ts:174`(parseStringId 拿 validAgentId 后塞 builder)
  - `ipc/sessions.ts:169` 调 `sessions-hand-off-helper.ts:25` 间接走 builder

- [x] **Step 2.2 — `omitUndefined` spread 模式调适** — 完成 by p4-d2-impl-20260515 (commit `ebefdfb`)
  - `spawn.ts:236`(R37 P1-Phase2 加的)+ `hand-off-session.ts:281-303`(R1 反馈实证 hand-off 真实组装点)
  - **⚠️ stub 漏列**:`sessions-hand-off-helper.ts:25 buildHandOffCreateSessionOpts` 是 RFC §1.5 漏列的第 6 处 caller helper(性质同 spawn.ts:236 omitUndefined helper),也 migration 改用 builder + 按 session.agentId narrow 自动保留 H6 sandbox 透传链(REVIEW_33)

### Phase 3: 可选 Option C `delegateOrThrow` helper(顺手做)

- [-] **Step 3.1 — `adapters/delegate-or-throw.ts`** — **跳过**:
  - 实施时发现 RFC §1.3 自评「收益小可不做」+ 当前 adapter lifecycle 方法行为不一致(有 throw 有 return — interruptSession/closeSession `return` 而 createSession/sendMessage `throw`),收口需独立 plan 决定一致行为后再实施。本 plan 跳过,留 followup

### Phase 4: 测试 + 异构对抗 review

- [x] **Step 4.1 — 加单测 `__tests__/adapter-create-options.type-narrow.test.ts`** — 完成 by p4-d2-impl-20260515 (commit `ebefdfb`)
  - 18 tests:runtime narrow 行为 + 6 个 `@ts-expect-error` 编译期约束 + typed adapter export runtime 验
  - 6 @ts-expect-error 全 trigger(typecheck 跑时 expected 行 TS 必须真报错否则 typecheck 报「Unused @ts-expect-error directive」)

- [x] **Step 4.2 — 复跑 regression** — 完成 by p4-d2-impl-20260515
  - typecheck 双端零 error / plan 指定 4 份 vitest 46 全过 / 全 vitest 596 passed / 64 skipped(better-sqlite3 ABI worktree 环境特有)

- [x] **Step 4.3 — 异构对抗 review** — 完成 by p4-d2-impl-20260515 (R1+R2+R3 三轮)
  - SKILL `agent-deck:deep-code-review` teammate 编排,reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5 xhigh
  - R1 → R1 fix `8a15a6f`:F2 claude bridge 显式 spread 9 字段(reviewer-claude MED) + F3 4 处 SSOT 守门(reviewer-codex MED, AssertSameKeys 双向 trick)
  - R2 → R2 fix `ad221de`:F4 抽 `AGENT_IDS as const` SSOT 驱动 isAgentId + 加守门 (5)(reviewer-codex MED) + F5 修注释表 (1) 行(reviewer-claude LOW)
  - R3 双方 0 真 finding 收口 Y(实测验证守门 (5) 真生效:临时漏 AGENT_IDS.aider → TS 报 2 个 error)
  - **5 处 TS 编译期强守门链**(types union ↔ builder switch ↔ ByAdapter entry ↔ AdapterIdMap entry ↔ AGENT_IDS list)+ 3 处 runtime 边界流程检查(register / MCP zod / cli enum)

### Phase 5: 收口

- [-] **Step 5.1 — REVIEW_X.md(可选)** — **跳过**:
  - plan 5.1 阈值「若 Phase 4.3 异构对抗有 ≥ 2 HIGH finding → 单独入 review」**未到**(R1+R2+R3 累积 0 HIGH,4 个 MED + 2 个 LOW 全 fix)
  - CHANGELOG_121 cover review process 摘要已足够,不再单建 review

- [x] **Step 5.2 — CHANGELOG_121 + plans/INDEX.md 同步** — 完成 by p4-d2-impl-20260515 (Phase 5 收尾 commit)
  - `changelog/CHANGELOG_121.md`(新建)+ `changelog/INDEX.md` append 一行
  - 本 plan 文件回写 Step checklist 状态 + Step 1.1 错误断言修正 + Step 1.2 registry typed overload 退化决策 + Step 2.2 RFC §1.5 漏列第 6 处 caller helper

- [x] **Step 5.3 — `mcp__agent-deck__archive_plan` 自动归档** — 收尾时执行(本 plan 文件 frontmatter status=in_progress → archive_plan 自动改 completed + 加 final_commit + completed_at + 同步 plans/INDEX.md + commit + worktree remove + branch -D + caller session shutdown)

## 当前进度

- ✅ **plan 完成**:Phase 1+2+4+5 全完成,Phase 3 显式跳过(理由文档化)
- ✅ **3 轮异构对抗 review 收口**:双方 R3 均 Y,5 处真 finding 全 fix(F1 plan stub 文档延后到本归档阶段)
- ✅ **守门链兑现**:5 处 TS 编译期强守门 + 3 处 runtime 边界流程检查,加新 adapter 漏改任一 TS 编译期都报错
- ✅ **typecheck + vitest 全过**:typecheck 双端零 error / vitest 596 passed / 64 skipped(better-sqlite3 ABI 环境问题,与 D2 无关)
- ✅ **commit chain**:Phase 1+2+test ebefdfb / R1 fix 8a15a6f / R2 fix ad221de / Phase 5 收尾 commit(本步)
- ⬜ ExitWorktree(action: keep)+ archive_plan 自动归档(下一步)

## 下一会话第一步

本 plan 已完成所有实施步骤。下一会话不需接力 — 走 archive_plan 收口即可:

1. lead 调 `ExitWorktree(action: "keep")` 切出 worktree
2. lead 调 `mcp__agent-deck__archive_plan({ plan_id: "p4-baseadapter-d2-implement-20260515", worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/p4-baseadapter-d2-implement-20260515" })` 自动收尾(ff merge worktree branch → main + frontmatter 改 status=completed + 同步 plans/INDEX.md + commit + worktree remove + branch -D + caller session shutdown)

## 已知踩坑(供后续 reviewer 参考)

- **EnterWorktree(name:) CLI stale base bug**:必走 Bash `git worktree add` + `EnterWorktree(path:)`(详 user CLAUDE.md §Step 1 末尾 callout)
- **worktree 内绝对路径**:Edit / Read / Write / Grep / Glob / Bash `git -C` 全部带 worktree 前缀
- **`hand-off-session.ts:281-303` 是 hand-off 真实组装点**(R1 实证),不是 `hand-off-session-impl.ts`
- **6 处生产 caller 一次性收口**(RFC §1.5 估 5 处 + 漏列 sessions-hand-off-helper.ts:25 第 6 处 helper)
- **`buildCreateSessionOptions` exhaustive switch** + 4 处 SSOT 守门 + AGENT_IDS list 5 处真 TS 编译期强守门链(任一漏改报错)
- **adapter 实例命名 export class type**:`claudeCodeAdapter: ClaudeCodeAdapter`(typed) — caller 直接 import 拿 typed instance,不走 registry overload(后者撞 union dispatch fail 已退化只保 string overload)
- **isAgentId 与 AgentId type 必须同源**:抽 `AGENT_IDS as const` 一份 SSOT 驱动两者(否则双源漂移加新 adapter 漏 isAgentId 字面量列表 TS 0 error 但 runtime guard 拒绝)

## 相关 followup

- **Chapter 2 实施**:`cross-adapter-sandbox-inherit-20260515.md`(已建 stub plan,串行实施 — 本 plan 收口后再启动)
- **Chapter 3 不需 plan**:加新 scheduler 时引用 RFC §3.3 命名 convention + §3.3.4 双类周期 settings 约定即可
- **Phase 3 Option C `delegateOrThrow` helper**:留独立 plan,需先决定 adapter lifecycle 方法一致行为(throw vs return)再实施

## 会话风格授权

承袭 RFC 决策范围 + 本 plan 实施性质:
- **RFC 已 sign-off 决策**(option 取舍 / 拆判别联合方向 / typed registry 形态)不再问用户,实施细节 lead 自主判断
- **新增 caller 命中点**(grep 漏 / 实际命中超 5 处)必须告诉用户征得确认 + 写入 RFC §1.5 touchpoint 修订
- **Phase 4.3 异构对抗 review HIGH finding** 默认采纳;反驳轮裁决属常规流程不打扰用户
- **真不能拆的决策点**(如 `delegateOrThrow` helper 是否同 PR 落地、bridge 端 createSession 签名是否需 narrow)拿不准时停下问用户
