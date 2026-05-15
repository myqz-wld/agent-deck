---
plan_id: "adapter-architecture-design-20260515"
created_at: "2026-05-15"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/adapter-architecture-design-20260515"
status: "completed"
base_commit: "d635dad"
base_branch: "main"
parent_review_id: "REVIEW_40"
parent_plan_id: "codex-claude-adapter-symmetry-20260515"
final_commit: "b1771e62c909a810498a9776e96faf6eb921e2a0"
completed_at: "2026-05-15"
---
# adapter-architecture-design-20260515 — adapter 架构层 design RFC(P4 BaseAdapter + 跨 adapter sandbox 继承 + scheduler 命名)

## 总目标 & 不变量

REVIEW_40 follow-up P2 架构层 3 个 design question 收口为 design RFC,**仅产出 design doc / 决策 / 实施路线,不动代码**。

**3 design question**(REVIEW_40 跨 plan follow-up):

1. **#1 P4 BaseAdapter / CreateSessionOptions 拆判别联合**(REVIEW_37 R1 finding,REVIEW_40 留独立架构 plan)
   - 4 adapter(claude-code / codex-cli / aider / generic-pty)共享基类抽取
   - CreateSessionOptions 大 union 拆判别联合(`agentId: 'claude-code' | 'codex-cli' | ...` 细分)
   - 触发条件:加新 adapter / 4 adapter 间 sandbox/permission 行为漂移频繁修

2. **#3 跨 adapter sandbox 继承**(reviewer-codex R1 HIGH-2 from REVIEW_40 — 实质 design question 不是 bug)
   - lead 是 claude 时 spawn 一个 codex teammate,sandbox 应按 codex 默认还是按某种映射?
   - sandbox enum value 不一致(claude `'off'/'workspace-write'/'strict'` ↔ codex `'workspace-write'/'read-only'/'danger-full-access'`),映射不平凡
   - 当前 spawn.ts:131 显式分两条 fallback chain,跨 adapter 不继承 — 是设计选择不是 bug

3. **#2 F2 scheduler 命名一致性**(REVIEW_37 R1 finding,reviewer-claude 自降级 INFO)
   - 多个 scheduler 类(LifecycleScheduler / SummarizerScheduler 等)命名风格不齐
   - 改造成本 > 收益,不主动重构,但 design 层面应记录命名规则供新 scheduler 参考

**design RFC 不变量**:
- **不动代码**(本 plan 不实施,仅产 design doc)
- 输出 = `docs/<rfc-id>-architecture.md` + 决策 sign-off + 实施 plan stub(等真触发条件命中再起 plan)
- design 走异构对抗(reviewer-claude / reviewer-codex 各自从架构视角 review design)
- 用户决策点明示(每个 design 决策都需用户 sign-off,本 plan 不替用户决策)

## 设计决策(不再争论)

### 1. 输出 = 1 个 RFC 文档 + 3 章节(每个 design question 1 章)

- `docs/adapter-architecture-rfc-20260515.md` 含:
  - Chapter 1:P4 BaseAdapter design — 状态、动机、设计 option A/B/C 对比、推荐方案、touchpoint estimate、test plan、迁移路线
  - Chapter 2:跨 adapter sandbox 继承 design — 同款结构
  - Chapter 3:scheduler 命名 design — convention 规则记录(不重命名既有,新 scheduler 按 convention)

### 2. design 阶段流程

- Phase 1:lead 写 RFC 初稿(每章 outline + option list + recommendation)
- Phase 2:R1 reviewer-claude + reviewer-codex 异构对抗 review RFC(focus = 设计正确性 / 边界 / 实施代价 / 替代方案)
- Phase 3:三态裁决 + RFC 修订
- Phase 4:用户 sign-off 每章决策(yes/no/调整)
- Phase 5:每章产 follow-up plan stub(等真触发条件命中再起新 plan 实施)
- Phase 6:RFC 归档到 `docs/`,本 plan archive_plan

### 3. 不实施约束

本 plan 严格不动 src/ 代码。实施由后续触发条件命中时,新建 implementation plan(可参考 RFC 决策直接干):
- P4 BaseAdapter 触发:加第 5 个 adapter 时 / 4 adapter 间漂移修 ≥ 3 次
- 跨 adapter sandbox 继承触发:用户实际报「lead claude → spawn codex teammate sandbox 配错」bug
- F2 scheduler 命名触发:加新 scheduler 时(顺手按 convention 命名,既有不动)

## 步骤 checklist

### Phase 1: RFC 初稿(lead)

- [ ] **Step 1.1 — Chapter 1 P4 BaseAdapter outline**:状态(4 adapter 重复代码 grep 实证)/ 动机 / option A 抽象基类 / option B mixin / option C 不动 + helper 函数收口 / 推荐 / touchpoint / 实施代价
- [ ] **Step 1.2 — Chapter 2 跨 adapter sandbox 继承 outline**:状态(spawn.ts:131 当前 fallback chain)/ 动机 / option A 平凡映射 / option B abstract level / option C explicit per-target adapter default(当前)/ 推荐 / 实施代价
- [ ] **Step 1.3 — Chapter 3 scheduler 命名 convention outline**:状态(grep scheduler 类)/ 命名规则建议(`<Concept>Scheduler` 后缀 / 文件名 kebab-case / class CamelCase)/ 既有不重命名理由 / 新 scheduler 按 convention 守门

### Phase 2: R1 异构对抗 review RFC

- [ ] **Step 2.1 — spawn R1 reviewer pair**(team `arch-design-rfc-r1`):scope = `docs/adapter-architecture-rfc-20260515.md`,focus = 设计正确性 / 边界 / 实施代价 / 替代方案
- [ ] **Step 2.2 — 收 reply 三态裁决**:每章独立判定 ✅ accept / ❌ reject / ❓ revise

### Phase 3: RFC 修订 + 用户 sign-off

- [ ] **Step 3.1 — RFC 修订按 R1 反馈**
- [ ] **Step 3.2 — 用户 sign-off 每章决策**(AskUserQuestion 每章 yes/no/调整)

### Phase 4: 实施 follow-up plan stub

- [ ] **Step 4.1 — Chapter 1 stub**:`plans/p4-baseadapter-implement-<future-date>.md` 等触发条件 + 决策记录
- [ ] **Step 4.2 — Chapter 2 stub**:同款
- [ ] **Step 4.3 — Chapter 3 stub**:不需要 plan(下次加新 scheduler 时直接按 convention,在 commit 引用 RFC Chapter 3)

### Phase 5: 收口

- [ ] **Step 5.1 — RFC 归档到 `docs/`**(已在 Step 1 写到此位置,无需 mv)
- [ ] **Step 5.2 — REVIEW_<X+1>.md(可选)**:design RFC review 单独入 review,或合并到 CHANGELOG
- [ ] **Step 5.3 — CHANGELOG_<X+1>.md**:撰写归档 + plans/INDEX.md 同步
- [ ] **Step 5.4 — archive_plan**:`mcp__agent-deck__archive_plan` 自动归档

## 当前进度

- ⬜ **stub 状态**:本 plan 是 P0+P1 完成后才推进的 design plan,**当前未启动**。等用户后续显式 hand-off 触发或 P0/P1 某个 session 完成后顺势接力。
- ⬜ Step 1.1 RFC 初稿 Chapter 1

## 下一会话第一步(等触发后)

按 user CLAUDE.md cold-start 流程:

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/adapter-architecture-design-20260515.md` 全文读 plan
2. `EnterWorktree(name: "adapter-architecture-design-20260515")` 创建新 worktree
3. `git log --oneline -5` 自检 HEAD = d635dad(base_commit)或之后
4. **从 Step 1.1 开始动手**:
   - grep 4 adapter 共享代码 surface(spawn / sendMessage / closeSession / restartWithXxxSandbox)实证 P4 BaseAdapter 重复程度
   - 读 spawn.ts:131 看跨 adapter sandbox 当前 fallback chain
   - grep `class.*Scheduler` 看 scheduler 命名实证
   - 写 RFC Chapter 1-3 outline
5. 改完每步跑 `pnpm typecheck`(本 plan 仅 docs 改动 typecheck 应零变化);commit message 含「(arch-design-plan P<X> Step Y.Z)」
6. **设计决策 yes/no 必须问用户**(本 plan 是 design RFC,任何 architectural 决策都需用户 sign-off,不替用户决策)

⚠️ **跨会话第一次读 plan 必须用 `Bash: cat` 而非 `Read` 工具**

## 已知踩坑

- **不动 src/ 代码**:本 plan 严格 design 阶段,实施由后续触发条件命中时另开 plan
- **每个章节决策都需用户 sign-off**(用 AskUserQuestion)
- **archive_plan 前置必须先 ExitWorktree**

## 相关 follow-up

- **#6 codex sdk-bridge tests + #5 double rename cleanup**:留 plan `codex-sdk-bridge-tests-20260515`(独立 hand-off P0)
- **#7 extraAllowWrite + #4 recoverer waiter**:留 plan `cross-adapter-parity-20260515`(独立 hand-off P1)

## 会话风格授权(限制版)

承袭 REVIEW_40 plan「会话风格授权」**但本 plan design 阶段约束**:
- 任何 architectural 决策(option A/B/C 选哪个)**必须问用户 sign-off**,不替用户决策
- review 反馈采纳与否可 lead 自主判断(标准 R1 三态裁决)
- 真不能拆的部分(option 取舍 / 替代方案设计)拿不准时停下问用户
