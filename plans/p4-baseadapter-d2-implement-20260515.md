---
plan_id: "p4-baseadapter-d2-implement-20260515"
created_at: "2026-05-15"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/p4-baseadapter-d2-implement-20260515"
status: "in_progress"
base_commit: "a6dbbe07a3ffb35f41c6f04eb444e4446fab33c3"
base_branch: "main"
parent_rfc_id: "adapter-architecture-rfc-20260515"
parent_rfc_chapter: 1
parent_plan_id: "adapter-architecture-design-20260515"
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

- [ ] **Step 1.1 — `adapters/types.ts` 拆 4 interface + 判别联合**
  - 现 `CreateSessionOptions` 是单宽 interface(types.ts:26-125)
  - 拆为 `ClaudeCreateOpts` / `CodexCreateOpts` / `PtyCreateOpts`(aider+generic-pty 共享)+ 判别联合 `agentId: 'claude-code' | 'codex-cli' | 'aider' | 'generic-pty'`
  - 各 adapter `index.ts` 内 inline opts type 改引用对应 interface(机械)
  - jsdoc 字段说明分散到各 interface 头
  - typecheck 应零变化(adapter 内部已用 inline narrow,接口改名不影响行为)

- [ ] **Step 1.2 — typed registry overload + `buildCreateSessionOptions` builder helper**
  - `adapters/registry.ts` 加 `AdapterIdMap` + overload signature(`get<T>(id: T): AdapterIdMap[T] | undefined` + `get(id: string): AgentAdapter | undefined` 兜底)
  - `adapters/options-builder.ts`(新建)实装 `buildCreateSessionOptions<T>(agentId, raw)` exhaustive switch + `narrowToClaudeOpts` / `narrowToCodexOpts` / `narrowToPtyOpts`
  - 各 adapter `index.ts` 改 typed export(`export const claudeCodeAdapter: ClaudeCodeAdapter` 替换 `: AgentAdapter`,需先 export class type)

### Phase 2: caller migration

- [ ] **Step 2.1 — 5 处生产 caller 改 typed registry**(R1 实证 grep 命中)
  - `agent-deck-mcp/tools/handlers/spawn.ts:230`(主入口)
  - `cli.ts:268` + `cli.ts:315`(CLI 两处)
  - `ipc/adapters.ts:174`
  - `ipc/sessions.ts:133`
  - 每处改用 `buildCreateSessionOptions(agentId, rawArgs)` + typed adapter 实例 `adapterRegistry.get(agentId as 'claude-code' | ...)`

- [ ] **Step 2.2 — `omitUndefined` spread 模式调适**
  - `spawn.ts:236`(R37 P1-Phase2 加的)+ `hand-off-session.ts:281-303`(R1 反馈实证 hand-off 真实组装点,不是 hand-off-session-impl.ts)
  - 兼容新类型(可能需重写 spread+ternary 为 builder helper 调用)

### Phase 3: 可选 Option C `delegateOrThrow` helper(顺手做)

- [ ] **Step 3.1 — `adapters/delegate-or-throw.ts`(新建)**
  - 实装 `delegateOrThrow<R>(bridge, msg, fn): Promise<R>`(详 RFC §1.3 Option C snippet)
  - 各 adapter 内 5-8 行 boilerplate 缩到 1 行 helper 调用(机械)

### Phase 4: 测试 + 异构对抗 review

- [ ] **Step 4.1 — 加单测 `__tests__/adapter-create-options.type-narrow.test.ts`**
  - TS `expectError`(或 `// @ts-expect-error`)断言 `claudeCodeAdapter.createSession({ agentId: 'claude-code', codexSandbox: 'read-only' })` 编译报错
  - 同款断言 codex / pty adapter 误传字段

- [ ] **Step 4.2 — 复跑 regression**
  - `pnpm typecheck`(必须零 error)
  - `pnpm exec vitest run __tests__/spawn-guards.test.ts __tests__/hand-off-session.handler-cwd-generic.test.ts`(caller migration 不破坏行为)
  - `pnpm exec vitest run`(全单测)

- [ ] **Step 4.3 — 异构对抗 review**
  - 起 `deep-code-review` SKILL,scope = Phase 1-3 改动 diff
  - focus = 「TS narrowing 正确性 / caller migration 是否完整 / 漏改 caller 点 / 未来加第 5 adapter exhaustive switch 是否真覆盖」
  - 三态裁决修 ✅ HIGH

### Phase 5: 收口

- [ ] **Step 5.1 — REVIEW_X.md(可选)**
  - 若 Phase 4.3 异构对抗有 ≥ 2 HIGH finding → 单独入 review
  - 否则合并到 CHANGELOG

- [ ] **Step 5.2 — CHANGELOG_X.md + plans/INDEX.md 同步**

- [ ] **Step 5.3 — `mcp__agent-deck__archive_plan` 自动归档**

## 当前进度

- ⬜ **stub 状态**:本 plan 已建文件、未启动。等用户后续显式 hand-off 触发或 hand_off_session 接力。
- ⬜ Step 1.1 起手

## 下一会话第一步

按 user CLAUDE.md cold-start 流程:

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/plans/p4-baseadapter-d2-implement-20260515.md` 全文读 plan(强制 cat 不用 Read,详 user CLAUDE.md §Step 3 末尾 callout)
2. **避开 EnterWorktree CLI stale base bug**(详 user CLAUDE.md §Step 1 末尾 callout):用 Bash 显式建 worktree(隐式用 HEAD 作 base):
   ```bash
   git -C /Users/apple/Repository/personal/agent-deck worktree add -b worktree-p4-baseadapter-d2-implement-20260515 /Users/apple/Repository/personal/agent-deck/.claude/worktrees/p4-baseadapter-d2-implement-20260515
   ```
   然后 `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/p4-baseadapter-d2-implement-20260515")` 进入(注意是 path 不是 name)
3. 自检 worktree HEAD == main HEAD == frontmatter `base_commit` (`a6dbbe07a3ff...`):
   ```bash
   git -C /Users/apple/Repository/personal/agent-deck/.claude/worktrees/p4-baseadapter-d2-implement-20260515 rev-parse HEAD
   git -C /Users/apple/Repository/personal/agent-deck rev-parse HEAD
   ```
   不等 → `git -C <worktree-abs-path> reset --hard <main-HEAD>` 修正(参 user CLAUDE.md §Step 1 callout)
4. `Bash: cat /Users/apple/Repository/personal/agent-deck/docs/adapter-architecture-rfc-20260515.md` 读 RFC 全文(尤其 §1.3 Option D2 完整 typescript snippet + §1.5 touchpoint + §1.8 迁移路线)
5. `Bash: cat /Users/apple/Repository/personal/agent-deck/plans/cross-adapter-parity-20260515.md` 确认 `extraAllowWrite` 字段最终归属(RFC §1.8 Step 0 前置约束第二项)
6. **从 Step 1.1 开始动手**:打开 `src/main/adapters/types.ts:26-125` 看现 `CreateSessionOptions`,按 RFC §1.3 Option D2 拆 4 union arm
7. 改完每步:
   - **路径全用 worktree 内绝对路径**(详 user CLAUDE.md §Step 1 末尾 callout)
   - `pnpm typecheck` 必跑
   - commit message 含「(p4-d2-impl Step <X.Y>)」
8. 决策点(若有 caller 命中点新加 / typed registry 设计细节)告诉用户征得确认

⚠️ **跨会话第一次读「长期存在 + 其他会话动过的文件」必须用 `Bash: cat` 而非 `Read` 工具**(详 user CLAUDE.md §Step 3 末尾 callout)— 包括本 plan / RFC / parity-plan / 第一次接触的代码文件

## 已知踩坑

- **EnterWorktree(name:) CLI stale base bug**:必走 Bash `git worktree add` + `EnterWorktree(path:)`(详 user CLAUDE.md §Step 1 末尾 callout)
- **worktree 内绝对路径**:Edit / Read / Write / Grep / Glob / Bash `git -C` 全部带 worktree 前缀,否则操作主仓库文件(详 user CLAUDE.md §Step 1 callout)
- **`hand-off-session.ts:281-303` 是 hand-off 真实组装点**(R1 实证),不是 `hand-off-session-impl.ts`(后者仅解析 plan/prompt)— 改 sandbox / opts 字段透传一定改前者
- **5 处生产 caller 一次性收口**:不留半改半留(否则 D2 typed registry 收益失效一半)
- **`buildCreateSessionOptions` exhaustive switch**:加新 adapter 时 TS 编译期 `_exhaustive: never = agentId` 应该报错。单测里加一个故意漏 arm 的反例确认 default 分支真触发
- **adapter 实例命名 export class type**:`claudeCodeAdapter: ClaudeCodeAdapter`(typed) vs `: AgentAdapter`(union 兜底)— typed registry overload 调用时一定走 typed path 才有 narrow

## 相关 followup

- **Chapter 2 实施**:`cross-adapter-sandbox-inherit-20260515.md`(已建 stub plan,串行实施 — 本 plan 收口后再启动)
- **Chapter 3 不需 plan**:加新 scheduler 时引用 RFC §3.3 命名 convention + §3.3.4 双类周期 settings 约定即可

## 会话风格授权

承袭 RFC 决策范围 + 本 plan 实施性质:
- **RFC 已 sign-off 决策**(option 取舍 / 拆判别联合方向 / typed registry 形态)不再问用户,实施细节 lead 自主判断
- **新增 caller 命中点**(grep 漏 / 实际命中超 5 处)必须告诉用户征得确认 + 写入 RFC §1.5 touchpoint 修订
- **Phase 4.3 异构对抗 review HIGH finding** 默认采纳;反驳轮裁决属常规流程不打扰用户
- **真不能拆的决策点**(如 `delegateOrThrow` helper 是否同 PR 落地、bridge 端 createSession 签名是否需 narrow)拿不准时停下问用户
