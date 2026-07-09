---
plan_id: "codex-claude-adapter-symmetry-20260515"
created_at: "2026-05-15"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/codex-claude-adapter-symmetry-20260515"
status: "completed"
base_commit: "91c4568"
base_branch: "main"
parent_review_id: "REVIEW_37"
parent_plan_id: "deep-review-and-refactor-r37-20260515"
final_commit: "c4fc56ac3270716e24dc3a16c58788092e8eb3fe"
completed_at: "2026-05-15"
---
# codex-claude-adapter-symmetry-20260515 — codex/claude adapter 架构对称性 audit + fix

## 总目标 & 不变量

R37 收口后剩余「不在 R37 scope」事项中,本 plan 处理 **第 3 类:codex/claude adapter 架构对称性不对齐**(R37 R2 reviewer-codex 已发现 3 处 pre-existing HIGH-2/HIGH-3/MED-3,可能存在更多 R37 未覆盖的不对齐)。

**主线**:做一轮 codex-cli adapter vs claude-code adapter **全面 architectural symmetry audit**,以异构对抗 review 为驱动,fix 真不对齐处。

**顺手 polish**:R37 R3 reviewer-claude 单方提出的 2 条 INFO 碰到对应文件时一并修。

**不变量**:
- 所有改动 worktree 内跑,主仓库零污染
- 严格按异构对抗 → 三态裁决 → fix 流程,不引入「lead 单方推断不对齐」的修法
- 行为零变化为目标(纯对齐 / refactor 风格,不引入新功能)
- 改完 typecheck + 全套 vitest 必跑
- R37 已对齐部分(如 codex sdk-bridge 拆 input-pack/session-finalize/restart-controller 是镜像 claude sub-class)**不重复审视**,只看 R37 未覆盖的剩余不对齐
- 不动 P4 BaseAdapter / CreateSessionOptions 拆判别联合(架构级 plan 单立)
- 不动 F2 scheduler 命名一致性(改造成本 > 收益,自降级 INFO)

## 设计决策(不再争论)

1. **R1 异构对抗驱动**:不依赖 R37 R2 reviewer-codex 历史 finding 复原(closed sid `1e961eca` 数据保留但 mcp tool 拉不到方便接口),直接 spawn 一对 reviewer-claude + reviewer-codex teammate 做 fresh symmetry audit;R37 R2 已知的 HIGH-2/HIGH-3/MED-3 写进 init prompt skip 字段让 reviewer 不重新「发现」(直接验证 fix 是否对症 + 找 R37 未覆盖的剩余)
2. **R1 review scope = codex/claude adapter 对称性专题**(focused single-topic review),不做 macro 全 scope 重构机会扫描:
    - claude adapter (`adapters/claude-code/index.ts` + `sdk-bridge/*` + `sandbox-config.ts` + `sandbox-resolve.ts`)
    - codex adapter (`adapters/codex-cli/index.ts` + `sdk-bridge/*` + `codex-instance-pool.ts`)
    - 共享 caller (`spawn.ts` / `hand-off-session.ts` / `restart-controller` / `recoverer`)
    - sub-focus:sandbox 字段命名 / restart method signature / resume defense / event emit 时序 / ensureXxx pool 模式 / SDK lifecycle 边界
3. **R37 已对齐部分不再审**:CHANGELOG_110 「Step 3.4 codex sdk-bridge 拆 input-pack/session-finalize/restart-controller」已与 claude 镜像;CHANGELOG_109 「codex hand-off 走 codex SDK」已对齐 claude path。R1 init prompt 写明这些 skip
4. **R2 review 复审 fix 不引新 bug**:与 R37 同款,reviewer-codex 易撞 fix-to-fix bug(R37 R2 HIGH-1 baton role 是先例)
5. **顺手 polish (R37 R3 INFO)**:仅当本 plan 已 spawn 改 recoverer.ts 或 archive-plan-impl.ts 的 commit 时才一并做(避免单建 trivial commit)
    - **INFO #1**(`recoverer.ts:465-475` + `recoverer-messages.ts:27-28`):docstring 写「单行字面量留 inline」实际 L465 是 2 行 template literal。修法二选一(看哪个本 plan 触发更自然):(a) 更新 docstring 措辞 (b) L465 一并收口到 emitFallbackMessage(helper 接受任意 text 参数)
    - **INFO #2**(`archive-plan-impl.ts:61-68` `ArchivePlanResult` 与 `schemas.ts:465` `ArchivePlanResult` 同名命名碰撞):rename impl 内部 type 加 `Impl` 后缀(`ArchivePlanImplResult` 等 7 个 result type 一并)
6. **每个 phase 独立 commit**,message 引用「(symmetry-plan P<X>-Y)」
7. **跨会话 hand-off**:同 R37,用 `mcp__agent-deck__hand_off_session(plan_id, phase_label)` 自动起新 session + archive caller;新 session **不传 team_name**(本 plan 第一次 hand-off 时 R37 R2 HIGH-1 baton role fix 已 commit 但 app 是否部署待用户确认 — 安全起见同 R37 不依赖 fix 已部署)
8. **scope 边界明示**:reviewer 提的 finding 若涉及 P4 BaseAdapter 系统性架构改造 → 标 INFO/未验证 不修(留独立 plan);若涉及 F2 scheduler 命名 → 标 INFO 不修(plan 决策已声明)

## 步骤 checklist

### Phase 1: R1 异构对抗 codex/claude 对称性 audit

- [ ] **Step 1.1 — spawn 一对 R1 reviewer**:`spawn_session` claude-code adapter,`agent_name: 'reviewer-claude'` / `'reviewer-codex'`,team_name = `codex-claude-symmetry-r1`,cwd = worktree。init prompt 含:
    - scope 文件清单(claude adapter 7 文件 + codex adapter 6 文件 + 共享 caller 4 文件)
    - focus(6 个 sub-focus,见设计决策 2)
    - skip 字段:R37 已对齐部分(CHANGELOG_110 Step 3.4 + CHANGELOG_109 codex hand-off)/ R37 R2 已知的 HIGH-2/HIGH-3/MED-3 摘要(让 reviewer 直接验证而非重新「发现」)
    - 不在本 plan scope 提示:P4 BaseAdapter / F2 scheduler 命名(reviewer 提到这两类 → 自降 INFO)
    - 输出契约:reviewer-claude.md / reviewer-codex.md 标准 finding 输出契约
- [ ] **Step 1.2 — 收两份 reply 做三态裁决**:按 user CLAUDE.md §决策对抗 三态裁决,真问题 + 双方独立 → ✅ HIGH 必修;单方独有 HIGH → 反驳轮(spawn 对方 reviewer 反驳一次);MED → lead 自己验证;LOW/INFO → 直接 ❓

### Phase 2: R1 fix 落地

具体步骤待 R1 finding 决定。预计 fix 类型(基于 R37 R2 已知):

- [ ] **Step 2.1 — HIGH-2 sandbox 字段命名对齐**:codex 与 claude 的 sandbox 字段命名(`codex_sandbox` / `claudeCodeSandbox` 等)若不齐 → 选一边对齐(优先 claude 因 claude sandbox 已 REVIEW_15 实测铁证 + 字段更稳定)。涉及 schema / Row / opts / settings 多处
- [ ] **Step 2.2 — HIGH-3 restartWithXxxSandbox method signature 对齐**:`restartWithCodexSandbox` vs `restartWithClaudeCodeSandbox` 命名 + signature(参数顺序 / opts shape / 返回类型 / try/catch / cleanup 时序)对齐
- [ ] **Step 2.3 — MED-3 codex resume defense 对齐 claude**:claude 有完整 resume jsonl missing fallback(REVIEW_36 HIGH-1 修过)+ implicit fork rename defense(CHANGELOG_108 INFO follow-up codex 加过类似的)— 验证 codex 同款路径是否完整
- [ ] **Step 2.4 — R37 未覆盖的剩余不对齐(R1 新发现)**:占位,具体看 R1 finding

### Phase 3: R2 复审

- [ ] **Step 3.1 — spawn 一对 R2 reviewer 复审**:同 R37 模式,team `codex-claude-symmetry-r2`(必要时复用 R1 reviewer mental model — 通过 hand-off 时显式 keep_teammates=true,详见 R37 R3 教训)。focus = R1 fix 是否对症 + 0 引新 bug + 是否引入 architectural drift
- [ ] **Step 3.2 — R2 三态裁决 + R2 fix 落地**:R2 真问题 fix(预留 1-2 commit)

### Phase 4: 顺手 polish(条件触发)

- [ ] **Step 4.1 — R37 R3 INFO #1**(条件触发):仅当 Phase 2/3 已修 recoverer.ts 时一并做。不动则跳过
- [ ] **Step 4.2 — R37 R3 INFO #2**(条件触发):仅当 Phase 2/3 已修 archive-plan-impl.ts 时一并做。不动则跳过

### Phase 5: 收口

- [ ] **Step 5.1 — R3 收口 review**:R2 + Phase 4 完成后,跑 R3 验收 final state(典型 spawn 全新 R3 reviewer 对,team `codex-claude-symmetry-r3`,init prompt skip = R1 + R2 已 fix 摘要)
- [ ] **Step 5.2 — REVIEW_38.md 撰写 + reviews/INDEX.md 加行**
- [ ] **Step 5.3 — CHANGELOG_111+ 撰写 + changelog/INDEX.md 加行**(R3 收口完成后才确定具体编号 — `ls changelog/CHANGELOG_*.md | sort -t_ -k2 -n | tail -1` 找最大 X+1)
- [ ] **Step 5.4 — archive_plan**:调 `mcp__agent-deck__archive_plan` 自动归档(前置 ExitWorktree(action: "keep"))

## 不在本 scope(显式声明)

### 第 1 类:P4 BaseAdapter / CreateSessionOptions 拆判别联合(R37 R1 finding)

- 4 adapter 共享基类抽取 + CreateSessionOptions 大 union 拆判别联合(`agentId: 'claude-code' | 'codex-cli' | ...` 细分)
- 是 architectural 大改造(state ownership 重组 + 4 adapter 多 caller 同步 + 大量测试 mock 改造)
- 与本 plan「codex/claude 对称性单话题」focus 不同 — 本 plan 是「对齐 2 adapter」,P4 是「抽 4 adapter 共享基类」
- **后续:留独立架构 plan,典型 trigger:加新 adapter / 4 adapter 间 sandbox/permission 行为漂移频繁修**

### 第 2 类:F2 scheduler 命名一致性(R37 R1 finding,reviewer-claude 自降级 INFO)

- 多个 scheduler 类(LifecycleScheduler / SummarizerScheduler 等)命名风格不齐
- reviewer-claude R37 R1 自降级 INFO + 改造成本 > 收益
- **不做。下次加新 scheduler 时一并 rename(顺手)即可**

## 当前进度

- ⬜ 等本会话(R37 plan 接力会话)写完本 plan + 创 worktree + 起新 session 接力
- ⬜ Step 1.1 R1 reviewer spawn

## 下一会话第一步

按 user CLAUDE.md cold-start 流程:

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/codex-claude-adapter-symmetry-20260515.md` 全文读 plan
2. `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/codex-claude-adapter-symmetry-20260515")` 进 worktree(用 `path` 不是 `name`)
3. `git log --oneline -5` 自检 HEAD = 91c4568(base_commit) 或之后
4. **从 Step 1.1 开始动手**:
    - spawn 一对 R1 reviewer-claude + reviewer-codex(team `codex-claude-symmetry-r1`,cwd = 当前 worktree)
    - init prompt 严格按 plan §设计决策 2 + skip 字段定义构造(scope 13 文件 + 6 sub-focus + skip 字段含 R37 已对齐 + R37 R2 已知 3 处)
    - 等 reply 自动注入 conversation flow,做三态裁决
5. 改完每步跑 `pnpm typecheck` + 影响范围内的 vitest;commit message 必须含「(symmetry-plan P<X> Step Y.Z)」
6. 进度变更先告诉用户征得确认(autonomous mode 下 trivial 决策不需要,真歧义才停)

⚠️ **跨会话第一次读 plan 必须用 `Bash: cat` 而非 `Read` 工具**(详 user CLAUDE.md §Step 3 末尾 callout)

## 会话风格授权(autonomous mode)

**承袭 R37 plan「会话风格授权」节内容**(用户在 R37 plan 创建时明示授权,延续至本接力 plan):

- **连续推进**:lead 不需为每一步切换 / 决策征求用户确认;按 plan checklist 顺序自主推进,遇真歧义(plan 决策外的二选一)才停下问用户
- **lead 自主决定 hand-off 时机**:不预设固定 phase 边界,按 user CLAUDE.md §Step 2.5 触发信号综合判断;触发后调 `hand_off_session(plan_id, phase_label)` 自动起新 session + archive caller
- **指令一路传下去**:本节是接力会话风格 SSOT,每个新 session cold-start 读完 plan 即知本节
- **本节不动**:除非用户明示撤回授权,新 session 不删 / 不改本节

**触发用户介入的真歧义清单**(仅这些情况停下问用户):
- plan 设计决策外的二选一
- 测试失败疑似真 bug 而非平移引起的预期 diff
- 真不能拆的 ≥ 500 LOC 文件该不该写「不动文件保护清单」边界拿不准
- 用户对话中显式新指令(中断 autonomous 切回 user-driven)
- 安全 / 数据可逆性高风险操作(git push --force / DROP TABLE / 删 worktree 等不可逆动作前)

## 复用历史 reviewer mental model(R37 R3 教训)

⚠️ **R37 R3 教训**:plan 设计 R3 应复用 R2 reviewer mental model,但 R2 reviewer 被中间 hand-off 会话默认 `keep_teammates=false` 误 shutdown → R3 必须 spawn 全新对。本 plan 吸取教训:

**关键约束**:本 plan 全程 hand-off 时**显式传 `keep_teammates: true`**(无论 spawn_session / archive_plan / hand_off_session)— 让 R1 reviewer 在 Phase 2 fix 期间保留 mental model,R2 复审复用 R1 同对 reviewer。

**例外**:plan 收口(Step 5.4 archive_plan)时**默认 keep_teammates=false** — 收口后 reviewer 不再用,自动 shutdown 防 ghost。

## 已知踩坑(看 R37 历史)

- **不能默认沉默忽略「真不能拆」的文件**(项目 CLAUDE.md §单文件 ≤ 500 行护栏)
- **archive_plan 前置必须先 ExitWorktree**(CLI 内部 tool 限制)
- **base_branch 是 main**(本 plan 切 worktree 时主仓库 HEAD 在 main)
- **R37 R2 HIGH-1 baton role fix 已 commit 但运行 app 是否部署不确定**:本 plan hand-off 不依赖该 fix 已部署 — 不传 team_name 时按 R37 R3 选项 2「spawn 全新 reviewer」。如果用户在做 plan 期间 `pnpm dist` + 重装 app,后续 hand-off 可改为传 team_name(让新 session 加入原 team 当 lead 不触发 0-lead auto-archive)
- **dormant ≠ 丢 mental model**(应用 CLAUDE.md §dormant 节):reviewer dormant 后 send_message 自动 SDK resume 复原对话历史;唯一例外 jsonl 缺失走 hard fail fallback → reviewer 触发 ⚠ FRESH SESSION warn 必须重 spawn
- **R37 plan 引用**:已 archived 到 `plans/deep-review-and-refactor-r37-20260515.md`(主仓库 git 内),REVIEW_37.md 引用 R1+R2+R3 三态裁决详,可作为 R37 mental model snapshot
