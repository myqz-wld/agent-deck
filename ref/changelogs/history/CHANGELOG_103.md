# CHANGELOG_103

## 概要

REVIEW_35 follow-up 优先级 1（5 真问题）+ 优先级 2（4 测试盲区）落地（plan `review-35-followup-p1-p2-20260514`）。1 commit 9 文件 +390/-36 = 修复真问题 + 测试补全 + 0 引入新功能。详见 [reviews/REVIEW_35.md §Follow-up plan 候选](../../reviews/history/REVIEW_35.md#follow-up-plan-候选)。

## 关联 commit

- `914e33d` follow-up 优先级 1+2 (9 真问题修复 + 测试补全)

## 变更内容

### 优先级 1：真问题修复（5 条）

- **C-M5** `pty-bridge/message-io.ts` sendMessage emit/write 顺序倒置 + try/catch 兜底（write 成功后才 emit user message；throw 时 emit error message 让 UI 知道失败）
- **C-M1** `pty-bridge/index.ts` listener 紧贴 ptySpawn 后注册 + earlyDataBuffer/earlyExit 缓存机制（解决 codex 实测 misses=6/20 秒退命令丢 exit）
- **rF R2-2** `pty-bridge/lifecycle.ts` SIGTERM/SIGKILL kill() throw 兜底（清 fileWatcher + emit session-end + sessions.delete）
- **rH R2-M3** `useImageAttachments` mountedRef + generationRef 防 unmount/clear/remove race（in-flight add() 完成后检查 generation 不匹配则丢弃）
- **rH R2-M4** `main/index.ts` HookServer EADDRINUSE fail-loud（dialog.showErrorBox + app.exit(1) 释放单实例锁，不让应用半启动）

### 优先级 2：测试补全（4 条）

- **A1 R2** `universal-message-watcher.test.ts` backpressure stateful test（5 case 覆盖 N=10/11/12/17 + N=11 X + 5 Y 跨 target 不饿死）
- **A2 R2** `agent-deck-repos.test.ts` findActiveMembershipIn 4 case + listActiveMembers JOIN archived 1 case
- **rE R2 #2** `ansi-parser.test.ts` IdleDetector dispose flag 2 case
- **rE R2 #3** `can-use-tool.test.ts` TaskOutput READ_ONLY 短路 2 case

## 测试与构建

- typecheck: 0 errors
- vitest: 475 passed (+8 新增) + 64 skipped (含新加 5 个 SQLite-binding-skip case) / 0 failed

## Follow-up 留独立 plan

- **A3 starvation guard 公平排队**（架构改动 - per-target fair scheduling 需重设计 findEligible SQL 排序 + process loop 决策）
- **优先级 3 拆分护栏**：universal-message-watcher 539 / summarizer 613 / preload 524 / ComposerSdk 512 LOC（1 文件 1 plan，避免高风险拆分混合）
- **优先级 4 cosmetic**：GIF dataUrl 入 state / Promise.all 双倍读 base64 / COMPRESS 7 档卡 UI / 多条 LOW
