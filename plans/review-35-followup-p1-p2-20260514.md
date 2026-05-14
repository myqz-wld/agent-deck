---
plan_id: "review-35-followup-p1-p2-20260514"
created_at: "2026-05-14"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/review-35-followup-p1-p2-20260514"
status: "completed"
base_commit: "41b0922"
base_branch: "main"
final_commit: "3e13b1dfd054ec8bacc11be98af73d10d8706831"
completed_at: "2026-05-14"
---
# REVIEW_35 follow-up 优先级 1+2 实施

## 总目标 & 不变量

- **目标**：落地 REVIEW_35 follow-up 优先级 1（5 条真问题，A3 starvation guard 跳过留独立 plan）+ 优先级 2（4 条测试盲区补全）= 9 条
- **不变量**：
  - 不引入新功能，纯 bug fix + 测试补全
  - 单 commit 内多文件修改但每条 fix 独立可 revert
  - typecheck 0 错 + vitest 全过

## 设计决策（不再争论）

1. **A3 starvation guard 公平排队不在本批**：rA-claude/rB-codex 双方一致认定真问题，但是架构改动（per-target fair scheduling 需重设计 findEligible SQL 排序 + process loop 决策），单独 plan 走，不混入本批
2. **优先级 3/4 也不在本批**：拆分（4 条 ≤500 LOC 护栏违反）+ cosmetic（GIF dataUrl / 双倍读 / COMPRESS 卡 UI 等）独立 plan
3. **不另写 REVIEW**：本批是 implementation 不是新 review，CHANGELOG_103 引用 REVIEW_35 即可

## 步骤 checklist

### 优先级 1：真问题修复

- [ ] **C-M5** pty sendMessage emit 在 write 之前 → write throw 时 UI 假已发
  - 文件：`src/main/adapters/generic-pty/pty-bridge/message-io.ts:52-60`
  - 修法：try/catch 包 write，throw 时 emit error message + rethrow
- [ ] **C-M1** pty-bridge listener 注册时序（秒退命令丢 exit）
  - 文件：`src/main/adapters/generic-pty/pty-bridge/index.ts:127`
  - 修法：onData/onExit listener 紧贴 `ptySpawn` 后立即注册，state init 在 listener 之后
- [ ] **rF R2-2** lifecycle.ts:46 SIGTERM kill() throw 时 sessions Map 不清
  - 文件：`src/main/adapters/generic-pty/pty-bridge/lifecycle.ts:46`
  - 修法：SIGKILL throw 兜底 + 强制 sessions.delete
- [ ] **rH R2-M3** useImageAttachments unmount race
  - 文件：`src/renderer/hooks/useImageAttachments.ts:262-320`
  - 修法：mountedRef + generationRef，clear/remove/unmount bump generation；resolve 后 generation 不匹配则丢弃
- [ ] **rH R2-M4** HookServer EADDRINUSE 只 log 半启动
  - 文件：`src/main/index.ts:163-170`
  - 修法：EADDRINUSE 给用户可见错误（dialog.showErrorBox）+ app.exit(1)，不让应用半启动

### 优先级 2：测试补全

- [ ] **A1 R2** backpressure stateful test
  - 文件：`src/main/teams/__tests__/universal-message-watcher.test.ts`
  - 修法：spy.mockImplementation 替换 mock fn，验证 N=11 deliver / N=17 starvation guard / N=10 全 deliver
- [ ] **A2 R2** findActiveMembershipIn 单测 + listActiveMembers JOIN 回归测试
  - 文件：`src/main/store/__tests__/agent-deck-repos.test.ts`
  - 修法：4 case：findActiveMembershipIn happy / left / no team / listActiveMembers JOIN exclude archived
- [ ] **rE R2 #2** IdleDetector dispose flag regression test
  - 文件：`src/main/adapters/generic-pty/__tests__/ansi-parser.test.ts`
  - 修法：dispose 后 onData noop test
- [ ] **rE R2 #3** TaskOutput READ_ONLY regression test
  - 文件：`src/main/adapters/claude-code/sdk-bridge/__tests__/can-use-tool.test.ts`
  - 修法：default + TaskOutput → 白名单短路 allow + 不弹 PendingTab

## 当前进度

Step 1 done。worktree HEAD = 41b0922 (main HEAD)，pwd = `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/review-35-followup-p1-p2-20260514`。下一步：按 checklist 顺序修。

## 下一会话第一步

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/review-35-followup-p1-p2-20260514.md`
2. `EnterWorktree(path: '/Users/apple/Repository/personal/agent-deck/.claude/worktrees/review-35-followup-p1-p2-20260514')`
3. 看 checklist 最后未勾的一步开始干

## 已知踩坑

- 路径必须含 worktree 前缀（同 REVIEW_35 plan）
- pnpm install 在 worktree 内可能需要 electron install.js 跑一遍恢复 binary（见 REVIEW_35 经验）
