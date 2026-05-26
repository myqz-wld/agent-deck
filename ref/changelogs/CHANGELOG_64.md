# CHANGELOG_64: deep-code-review skill 流程重构 + 复杂 plan hand off 约定（双对抗 review 收口）

## 概要

把「先建 team 再 spawn teammate」从 deep-code-review skill 的隐式步骤上提为
显式 §Step 2，与 §Step 3 初轮 spawn 解耦（TeamCreate 与 Round 概念正交）；
同时全局 + 应用级两份 CLAUDE.md 加新顶层节「复杂 plan：worktree 隔离 +
跨会话 hand off」，明示触发 + 4 步流程 + 与已有机制的关系。reviewer-claude
+ reviewer-codex 双对抗 review 共出 1 HIGH（反驳 1）/ 6 MED / 2 LOW / 5
SUGGEST-SIMPLIFY，全部 fix（含 ExitWorktree(remove) 跨会话必拒、/cost →
/context、plan 文件落 main repo 绝对路径、零污染语义修正、task_create 时
机统一、触发条件压成 2 核心信号、与决策对抗 plan 概念边界澄清等）。

## 变更内容

### resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md

- 拆分原 Step 2「初轮：建 team + spawn」为 §Step 2「建 team（前置基础设施，
  整轮 review 仅一次，与 Round 概念正交）」+ §Step 3「初轮 spawn（Round 1
  启动）」。后续 Step 编号顺延为 4-7。
- description 简化 1073 → 698 bytes：移除 TeamCreate 机制详述，留高层定位
  + 触发短语；机制全部固化在 §Step 2-3 红字护栏。
- §Step 2 「自检」小节合并到红字段尾一句 cross-ref，省 4 行。
- §Step 3 task_create 时机修正：与 §Milestone tracking 表第 1 行「spawn
  之前」对齐（原来分歧描述 spawn 完后建）。
- 反模式表两条新条目（跳过 TeamCreate / TeamCreate + spawn 同 message 并发）
  合并为一行 cross-ref，outcome 列指向 §Step 2 红字段单一 SoT。

### resources/claude-config/CLAUDE.md + ~/.claude/CLAUDE.md（同步，仅前者入 git）

新增顶层节 `## 复杂 plan：worktree 隔离 + 跨会话 hand off`，位置在
「Agent Teams」节末与「新项目工程地基」之间（按抽象层级 runtime → workflow
→ setup 排序），约 63 行。要点：

- **触发**（任一核心信号）：预计跨 ≥ 2 会话才能收口（综合启发：≥ 5 个非 trivial
  step / 跨多模块 / ≥ 数百行代码 / 当前会话已吃 ≥ 40-50% context，看 `/context`）；
  或破坏性 / 实验性希望失败时整片回退。
- **Step 1 EnterWorktree**：name 命名 `<topic>-<YYYYMMDD>`，字符集
  `[A-Za-z0-9._-]` 单 segment ≤ 64 字符（与 EnterWorktree CLI 校验对齐）。
  本节即对该工具的显式授权（默认禁用）。
- **Step 2 plan 文件**：`<main-repo-abs-path>/.claude/plans/<plan-id>.md`
  绝对路径写入 main repo（不写到 worktree working tree——worktree 是独立
  branch，跨会话 main repo 看不到）。frontmatter（plan_id / created_at /
  worktree_path / status）+ 总目标 + 设计决策 + 步骤 checklist
  （commit `<hash|uncommitted>`）+ 当前进度 + 下一会话第一步 + 已知踩坑。
- **Step 3 接力**：会话末必更新 plan + `ExitWorktree(action: "keep")`；新
  会话 Read plan → `EnterWorktree(path)` → 按下一会话第一步直接动手。
- **Step 4 cleanup**：⚠️ `ExitWorktree(action: "remove")` 在 path 进入的现有
  worktree 上 CLI validateInput 直接拒（errorCode 4）—— 跨会话场景统一走
  `ExitWorktree(keep)` + Bash `git worktree remove` 手动清理，避免分两条路径。
- **与其他机制关系**：载体分工（plan vs changelog vs mcp__tasks__*）+ 决策
  流程分工（机械触发不评审 vs ExitPlanMode 输出设计内容进 plan 文件「设计
  决策」节 vs 决策对抗 plan 内决策该走还得走）；末尾引文澄清 "plan" 一词
  两种语义。

## 备注

- 双对抗 review 反驳 1 条：reviewer-codex HIGH 关于 SKILL.md L107-L123 「Agent
  工具 shape 不接受 `team_name + name`」基于过期源码理解，现场 system prompt
  JSON Schema 验证 Agent 工具确实有 `name` + `team_name` properties，不修。
- 两份 CLAUDE.md diff 仍只在顶部 7 行注释处差异，新节内容完全一致。
- 本次未触发 `reviews/` 流程（属于约定升级 + skill 流程优化，按全局 CLAUDE.md
  分类规则归 `changelog/`）。
