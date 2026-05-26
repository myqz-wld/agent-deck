---
plan_id: "deep-review-and-refactor-20260514"
created_at: "2026-05-14"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-refactor-20260514"
status: "completed"
base_commit: "d06494e98c8e5a6d7eef2b0fc66ea6e69bf07d5a"
base_branch: "main"
final_commit: "41b092230ddd10d3136ffc34837b039fb2ca5141"
completed_at: "2026-05-14"
---
# Deep code review × 重构机会扫描（agent-deck 全项目热点综合）

## 总目标 & 不变量

- **目标**：用 deep-code-review SKILL 的多轮异构对抗模式扫描 12 个「高 LOC + 高 churn + 跨多模块 + 未在最近 R 级 deep review 反复审过」的热点文件，挖深层 bug / race / leak / 重构机会 / 性能尾延迟 / 测试盲区。
- **不变量**：
  - 不重审已被 CHANGELOG_98/99/REVIEW_32/REVIEW_34 多轮覆盖的 mcp tool simplify / hand_off_session / archive_plan / spawn-guards / cwd resilience 范围
  - 全程 review × fix 多轮收口（用户选项），fix 阶段也在本 worktree 内做
  - 双 reviewer 必须 gpt-5.5 + Opus 4.7 异构（reviewer-codex + reviewer-claude），失败兜底走 SKILL §失败兜底
  - 收口要求：双方都「可合」+ 0 HIGH/MED + 关联测试 + REVIEW_35.md + INDEX 同步 + archive_plan 归档

## 设计决策（不再争论）

1. **Scope = 热点综合**：12 文件，分 4 batch（每 batch 3 文件，主题相近便于 reviewer 反推关系）：
   - Batch A — Universal team backend 数据层 + 路由层
   - Batch B — Session 子系统（summarizer / preload / store）
   - Batch C — Adapter / PTY / 安全护栏
   - Batch D — Renderer + 资源管理 + 未审热点
2. **2 wave 并发**：spawn-guards fan-out 上限通常 5，分两波（每波 2 batch × 2 reviewer = 4 并发）控制饱和。
   - Wave 1 = Batch A + Batch B
   - Wave 2 = Batch C + Batch D
3. **2 轮深度**（用户选项）：R1 浅层 + 修复正确性，R2 边界/race/lifecycle，反驳轮按需。
4. **Fix 在本 worktree 内做**：HIGH 立即 fix；MED 在 R2 收口前 fix；LOW/INFO 列入 REVIEW_35 不修。
5. **跨 batch 复用同一对 teammate**：第 N batch 的 reviewer 也用于第 N+1 batch（节省 spawn quota）。如果 batch 主题切换太大，重新 spawn 单独一对。

## 完整 12 文件 scope（按 batch）

### Batch A — Universal team backend 数据层 + 路由层

- `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-refactor-20260514/src/main/store/agent-deck-message-repo.ts` (487 LOC, 最近 mcp simplify 大改后未深审)
- `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-refactor-20260514/src/main/store/agent-deck-team-repo.ts` (REVIEW_23 后未深审, 最近 churn 1338)
- `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-refactor-20260514/src/main/teams/universal-message-watcher.ts` (539 LOC, wire prefix dispatch 关键路径)

### Batch B — Session 子系统

- `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-refactor-20260514/src/main/session/summarizer.ts` (546 LOC 全项目最大, 三档降级 LLM/最近 assistant/事件 kind 统计)
- `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-refactor-20260514/src/preload/index.ts` (526 LOC, window.api 强类型 facade 不变量)
- `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-refactor-20260514/src/renderer/stores/session-store.ts` (432 LOC, 渲染权威 store)

### Batch C — Adapter / PTY / 安全护栏

- `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-refactor-20260514/src/main/adapters/generic-pty/pty-bridge.ts` (549 LOC, REVIEW_24 后未重审, churn 1098)
- `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-refactor-20260514/src/main/adapters/claude-code/sdk-bridge/can-use-tool.ts` (366 LOC, READ_ONLY_TOOLS 白名单 + auto-approve 协议)
- `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-refactor-20260514/src/main/teams/inbox-watcher.ts` (551 LOC, fs watcher symlink TOCTOU + race)

### Batch D — Renderer + 未审热点

- `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-refactor-20260514/src/renderer/hooks/useImageAttachments.ts` (401 LOC, **从未被任何 review 覆盖** ⚠️)
- `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-refactor-20260514/src/renderer/components/SessionDetail/ComposerSdk.tsx` (484 LOC, REVIEW_19 拆完后未重审)
- `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-refactor-20260514/src/main/index.ts` (372 LOC, 主进程 bootstrap, 高 churn 26 commits/30d)

## 步骤 checklist

- [x] Step 1 — EnterWorktree + ff-merge main 进 worktree (commit d06494e)
- [ ] Step 2 — Wave 1 spawn 4 reviewer（Batch A + Batch B 各一对 reviewer-claude + reviewer-codex）
- [ ] Step 3 — Wave 1 收 reply + 三态裁决（含反驳轮按需）
- [ ] Step 4 — Wave 2 spawn 4 reviewer（Batch C + Batch D）
- [ ] Step 5 — Wave 2 收 reply + 三态裁决
- [ ] Step 6 — 汇总 R1 全部 finding + 决定 fix 顺序
- [ ] Step 7 — Fix HIGH/MED 在 worktree 内 + 跑 typecheck + vitest
- [ ] Step 8 — R2 review × 4 batch（复用同一对 teammate, skip = R1 fix 摘要）
- [ ] Step 9 — R2 三态裁决 + 反驳轮 + 收口判定
- [ ] Step 10 — 写 REVIEW_35.md + 同步 reviews/INDEX.md + CHANGELOG_X.md + archive_plan 收尾

## 当前进度

Step 1 done。worktree HEAD = d06494e，pwd = `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-refactor-20260514`。下一步 Wave 1 spawn 4 reviewer。

## 下一会话第一步

如果本会话 hand off：
1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/deep-review-and-refactor-20260514.md` 读全 plan
2. `EnterWorktree(path: '/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-and-refactor-20260514')`
3. `pwd` 确认 cwd
4. 看「步骤 checklist」最后未勾的一步开始干（不要重审已完成的步骤）
5. 进度 / 决策变更必须先告诉用户征得确认

## 已知踩坑

- **scope 路径必须含 worktree 前缀**（`.claude/worktrees/deep-review-and-refactor-20260514/` 开头），否则 reviewer 看的是主仓库不是 worktree → 会报 `⚠ SCOPE PATH MISMATCH` abort。详 user CLAUDE.md §Step 1 末 callout。
- **CHANGELOG_98/99/REVIEW_32/REVIEW_34 已审范围禁止重复**：mcp tool simplify / spawn-guards / hand_off_session / archive_plan / cwd resilience 等。如果 reviewer 误审到这些范围，发反驳引用既有 REVIEW 让其降 ❓ 或不修。
