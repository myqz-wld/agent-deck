---
plan_id: "hand-off-mcp-teammate-bug-20260515"
created_at: "2026-05-15"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/hand-off-mcp-teammate-bug-20260515"
status: "completed"
base_commit: "91c4568"
base_branch: "main"
parent_session_observation: "R37 archive_plan 收口后 hand-off 准备阶段用户实测撞到"
final_commit: "b3cf10ca29f8d23416ac4074220dc0202e89d1e7"
completed_at: "2026-05-15"
---
# hand-off-mcp-teammate-bug-20260515 — hand_off_session mcp tool 把新 session 挂成 teammate 排查

## 总目标 & 不变量

排查 application 内部 `mcp__agent-deck__hand_off_session` mcp tool **不传 team_name 时新 session 仍被挂成 teammate** 的 bug(用户实测 2026-05-15 R37 plan archive_plan 收口后 hand-off 准备阶段反映)。

**用户原话**:「然后『hand off mcp』还是会挂成 teammate」— 「还是」暗示这是已知或反复出现的问题。

**实测 trace**(本会话 R37 收口后调 hand_off_session 起 codex-claude-adapter-symmetry plan 接力会话时):

| 项 | 实际值 |
|---|---|
| caller(R37 archive_plan caller 会话) | sid `024289d4-7953-4d89-9c67-a6df3b9d69b3`,teams=[] (无 team membership) |
| hand_off_session args | `{ plan_id: "codex-claude-adapter-symmetry-20260515" }` — **不传 team_name** |
| mcp tool return | `teamId: null, teamName: null, agentName: null, displayName: null` ✓(看起来不挂 team) |
| 新 session sid | `008c3906-239e-48cf-a2de-03faa95c7d51` |
| **用户实测**(关键):新 session 在 UI 上 | **挂成 teammate** ⚠️ |

**核心异常**:mcp tool return 显示 teamId=null,但 UI 实际显示新 session 是某 team 的 teammate。

**可能 root cause(待排查)**:
1. **spawn handler 默认 batonRole 错**:R37 R2 HIGH-1 fix(commit 4ba8d25)透传 `batonRole='lead'` 在源代码里有,**但运行的 Agent Deck app 是老版本未部署**(fix 部署需 `pnpm dist` + 重装 .app,详项目 CLAUDE.md §打包与本地安装)。在老版本 app 上 hand_off_session 内部调 spawn 时没传 batonRole='lead' → spawn handler 默认走 teammate role
2. **spawn handler 内部 auto-join team 逻辑**:即使 hand_off_session 不传 team_name,spawn handler 可能基于 cwd / parent / 其他启发式自动把新 session 加入某个 team 当 teammate
3. **mcp tool return 字段不准**:teamId / teamName 在 return 里 null,但实际 sessionRepo 写入时挂了 team(return 字段 vs 实际 DB state 不一致)
4. **UI 显示 stale state**:UI 端 cache 没刷新,实际新 session 不挂 team 但 UI 显示挂(client-side bug,不是后端问题)
5. **agent_name 默认 fallback 路径**:hand_off_session 不传 agent_name → spawn handler 内部启发式选择 "teammate" 类型 agent_name → 自动 join

**潜在影响**:
- 新 session 加入意外的 team,可能干扰 team coordinator 时序 / inbox 通信
- 0-lead team 的 auto-archive 触发(若 caller 是 lead 而新 session 是 teammate,caller archived 后 team 0-lead → auto-archive)
- 用户预期独立新 session,实际被作为某 team 的 teammate → 协议混乱

**严重度**:HIGH(影响所有 plan 接力 hand-off 流程的可靠性,与 EnterWorktree stale base bug 同级)

**不变量**:
- 所有改动 worktree 内跑,主仓库零污染
- **新会话进 worktree 用 `EnterWorktree(path: ...)` 模式**(已 Bash 显式 base 创建好,绕开 EnterWorktree CLI bug)
- 改完 typecheck + 全套 vitest 必跑(若涉及代码改动)
- 行为零变化为目标(纯 bug fix)
- 不引入新功能

## 设计决策(不再争论)

1. **plan worktree 用 Bash 显式 base 创建**:本会话用 `git worktree add -b worktree-<plan-id> <worktree-path> 91c4568` 直接创,**绕开 EnterWorktree CLI stale base bug**(详 plans/worktree-stale-base-bug-20260515.md)。新会话进入用 `EnterWorktree(path: ...)` 模式
2. **复现实验姿势**:新会话排查时按下面顺序复现:
    - **复现实验 1(关键)**:Bash 在 mainRepo 调 `mcp__agent-deck__hand_off_session({ plan_id: <some-test-plan-id> })`(可临时建测试 plan),看 mcp tool return + 立即 `mcp__agent-deck__list_sessions(status_filter:'active')` 看新 session 的 teams[] 字段
    - **复现实验 2**:同上但传 `team_name` 显式 → 对照看 baton role 是否生效(R37 R2 HIGH-1 fix 透传 'lead' 路径)
    - **复现实验 3**:让用户在 UI 端打开新 session detail,截图发回 / 描述具体「挂成 teammate」的 UI 表现是什么(可能不是 team membership 而是 spawn / baton role label)
3. **排查方向优先级**(reviewer R1 也按此 focus):
    - **方向 A (high)**:R37 R2 HIGH-1 fix 是否真生效 — git log 4ba8d25 + grep `batonRole` in `spawn.ts` / `hand-off-session-impl.ts`,确认 worktree 代码状态;然后**确认运行 app 是否部署了该 fix**(用户跑 `pnpm dist` + 重装 .app 没有?dev mode 直接生效?)
    - **方向 B (high)**:hand_off_session impl 调 spawn 时,**新 session role 决策路径**完整 trace — 不传 team_name 时是否真不进入 team 路径?spawn handler 是否有 caller-team auto-inherit 逻辑(caller 在某 team → 新 session 自动加入)
    - **方向 C (med)**:mcp tool return 字段 vs 实际 DB state 一致性 — return 显示 null 但 sessionRepo 实际写入了 team_member 行?
    - **方向 D (med)**:UI 端「teammate」label 来源 — 是 team membership 维度还是 baton role / spawn role 维度?可能是 UI 用 baton role 字段显示「teammate」label,即使 team membership 为空
    - **方向 E (low)**:in-process / 跨 process state 同步 — mcp tool 走 in-process 调用,新 session 加入 team 的 sessionRepo write 是否同步到 UI 端 BroadcastChannel
4. **异构对抗 R1 review**:同 R37 模式,reviewer-claude + reviewer-codex teammate 各自独立 audit
    - reviewer-claude 偏 grep `team_member` / `batonRole` / `addMember` / spawn handler 实现 trace
    - reviewer-codex 偏 git log / commit diff / 时序 / system review
5. **fix vs document 决策**:R1 root cause 找到后:
    - root cause = R37 R2 HIGH-1 fix 未部署 → workaround:用户跑 `pnpm dist` + 重装 .app 即可生效;本 plan 文档化(无需代码改动)
    - root cause = spawn handler caller-team auto-inherit 逻辑 bug → 本 plan 内 fix(预计 trivial,< 30 LOC)
    - root cause = mcp tool return 字段错 → 本 plan 内 fix(trivial 字段对齐)
    - root cause = UI 显示 stale → fix UI 端,可能涉及多 component
6. **跨会话 hand-off**:同 R37,用 `mcp__agent-deck__hand_off_session(plan_id, phase_label)`;新 session **不传 team_name**(本 plan 排查的就是这个 path,继续不传以保持复现条件 + 同 R37 R3 教训)

## 步骤 checklist

### Phase 1: 复现 + 排查

- [ ] **Step 1.1 — 复现实验**:Bash 在 mainRepo 调 hand_off_session(目标:用 mcp tool 端复现 + 看 teams[] 字段是否真挂 team)
    - 实验 1:不传 team_name → 看 mcp return + list_sessions 新 session teams[]
    - 实验 2:传 team_name → 对比 baton role 是否 'lead'
    - 实验 3:在 UI 端确认「挂成 teammate」具体表现(role label 在哪显示 / team membership / 其他)— 此项可能需要新会话**让用户描述 UI 现象**(autonomous mode 下也允许 — 这是用户报项的核心 evidence,非真歧义不可避免)
- [ ] **Step 1.2 — 代码定位**:
    - `git log --oneline --all -- src/main/agent-deck-mcp/tools/handlers/spawn.ts` 找 R37 R2 HIGH-1 fix(4ba8d25)是否在 main HEAD
    - `grep -r "batonRole" src/main/agent-deck-mcp/tools/handlers/`
    - `grep -r "addMember\|team_member" src/main/agent-deck-mcp/tools/handlers/`
    - 确认 worktree 代码版本 vs 运行 app 版本(用户是 dev mode 还是装好的 .app?)
- [ ] **Step 1.3 — 异构对抗 R1 review**:spawn reviewer-claude + reviewer-codex teammate
    - team_name = `hand-off-mcp-teammate-r1`
    - init prompt 含完整复现 trace + 5 排查方向 + 已有 grep 实现位置(Step 1.2 输出)
    - focus = root cause 定位 + fix 路径建议

### Phase 2: fix / document

- [ ] **Step 2.1 — root cause fix**(条件 trigger):若 R1 找到代码层 root cause + fix < 50 LOC → 本 plan 内 fix + 守门测试
- [ ] **Step 2.2 — root cause document**(条件 trigger):若 root cause = R37 R2 HIGH-1 fix 未部署 → 文档化「dev mode 生效路径」+「打包重装路径」+「运行 app 版本检查命令」+ workaround,**无需代码改动**

### Phase 3: 收口

- [ ] **Step 3.1 — R2 复审**(条件 trigger):若 Phase 2 有 fix 落地,跑 R2 验证 fix 不引新 bug
- [ ] **Step 3.2 — REVIEW_X.md 撰写 + reviews/INDEX.md 加行**
- [ ] **Step 3.3 — CHANGELOG_Y+ 撰写 + changelog/INDEX.md 加行**
- [ ] **Step 3.4 — archive_plan**:调 `mcp__agent-deck__archive_plan` 自动归档(前置 ExitWorktree(action: "keep"))

## 当前进度

- ✅ R37 archive_plan 完成
- ✅ codex-claude-adapter-symmetry plan 已起 + 接力(`008c3906`)
- ✅ worktree-stale-base-bug plan 已起 + 接力(`958a9c09`)
- ✅ 本 plan 文件创建 + worktree Bash 显式 base 创建(避开 EnterWorktree bug)
- ⬜ Step 1.1 复现实验(下一会话首先做)

## 下一会话第一步

按 user CLAUDE.md cold-start 流程:

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/hand-off-mcp-teammate-bug-20260515.md` 全文读 plan
2. `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/hand-off-mcp-teammate-bug-20260515")` 进 worktree(用 `path` 不是 `name`)
3. `git log --oneline -3` 自检 HEAD = 91c4568
4. **从 Step 1.1 开始**:复现实验 + 必要时让用户描述 UI 现象
5. Step 1.2 grep 找代码 + 确认 R37 R2 HIGH-1 fix 状态
6. Step 1.3 spawn 一对 R1 reviewer

⚠️ **跨会话第一次读 plan 必须用 `Bash: cat` 而非 `Read` 工具**(详 user CLAUDE.md §Step 3 末尾 callout)

## 会话风格授权(autonomous mode)

**承袭 R37 plan「会话风格授权」节**(同款,见 plans/worktree-stale-base-bug-20260515.md 详细描述,本节不重复)

**触发用户介入的真歧义清单**:同 R37 + **本 plan 额外**:
- **Step 1.1 复现实验 3 必须问用户**:UI 上「挂成 teammate」具体显示在哪(role label / team list / spawn relation),这是用户报项核心 evidence,新会话 SDK session 看不到 UI

## 已知踩坑

- **不能依赖 mcp tool return 字段判断真实 state**:用户报「挂成 teammate」但 mcp return teamId=null,说明 return 字段可能不准 / UI 信源在别处
- **本 plan 排查的就是 hand_off_session bug 本身**:新会话需要清醒判断「自己是怎么被起的」(本 plan 的 hand_off_session 接力新会话时,新会话也会撞同款 bug — 是否挂成 teammate?这正好是 Step 1.1 实验 1 的天然复现 evidence!新会话第一件事可以 `mcp__agent-deck__get_session(session_id: <self-sid>)` 看自己 teams[] 字段)
- **R37 R2 HIGH-1 fix 在源码但 app 可能没部署**:这是排查的最大变量,务必先确认运行 app 版本(grep `batonRole` in dist .app bundle 不可行,看 app commit hash 或问用户跑过 pnpm dist 没有)
- **archive_plan 前置必须先 ExitWorktree**(CLI 内部 tool 限制)
- **base_branch 是 main**(本 plan 切 worktree 时主仓库 HEAD 在 main)
- **本 plan worktree 是 Bash 显式创建的**:与 application 内部 worktree state 可能不同步;ExitWorktree(action: remove) 失败时 fall back Bash `git worktree remove` 手工删
- **本 bug 与 EnterWorktree stale base bug 是不同独立 plan**:plan-worktree-stale-base-bug-20260515.md 排查 EnterWorktree CLI tool;本 plan 排查 hand_off_session mcp tool。两 plan 可以并发跑(独立 reviewer team)
