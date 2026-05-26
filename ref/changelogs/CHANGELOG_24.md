# CHANGELOG_24: REVIEW_5 修复落地（resume 路径两条 active 重复会话 + 单字段截断阈值放宽）

## 概要

修用户报项「历史会话点开发消息后，实时面板出现两条相同的 active 会话」+ 顺手修「展开后内容也不全」根因（main 进程单字段 8KB 截断）。REVIEW_5 双对抗（Plan subagent Opus 4.7 xhigh + Codex CLI gpt-5.4 xhigh）三态裁决后，按 H4（sdk-bridge 入口预占 claim + fallback 复用 OLD_ID）+ H1（manager dedupOrClaim 加 cwd 命中分支双保险）+ payload-truncate 阈值 8KB→64KB 三处落地。

## 变更内容

### 主进程 / SDK 通道时序保护（resume 路径根治）

#### `src/main/adapters/claude-code/sdk-bridge.ts`（H4）

- `createSession()` 入口：在 `expectSdkSession(opts.cwd)` 之后立即 `sessionManager.claimAsSdk(opts.resume)`（仅当 opts.resume 存在）。抢在 CLI 子进程内部 SessionStart hook 之前把 OLD_ID 加入 sdkOwned，hook 进 ingest 时第一道防线 `sdkOwned.has(event.sessionId)` 直接 skip，不再造 cli source 的复活 record
- `waitForRealSessionId()` 加 `resumeId?` 参数；30s fallback emit 错误消息时 `sessionId` 改用 `resumeId ?? tempKey`：让 ingest 走 `existing` 分支不再创建 tempKey 占位 active record，从根本上消除「OLD_ID + tempKey 两条 active」现象
- catch 路径补 `if (opts.resume) sessionManager.releaseSdkClaim(opts.resume)`，避免 createSession 失败后 sdkOwned 残留误吞同 sessionId 的真实 hook / 终端 CLI 会话

#### `src/main/session/manager.ts`（H1 双保险）

- `dedupOrClaim` 在原 A 分支（`!sessionRepo.get(id)` + cwd 命中 pendingSdkCwds → claim）基础上新增 B 分支：hook 事件即便 sessionId 已 existing，cwd 命中 pendingSdkCwds 时也走 claim + skip
- 防御 sdk-bridge.ts H4 修法的极短窗口（expectSdkSession 已注册但 `claimAsSdk(opts.resume)` 还没到 microtask 调度）+ 任何未来可能的别的入口绕过预占 claim 的场景
- 日志区分「new sid」/「existing sid」两条路径，便于线上排查

### 主进程 / 数据完整性

#### `src/main/store/payload-truncate.ts`

- `MAX_FIELD_BYTES` 从 `8 * 1024` 提到 `64 * 1024`：8KB 在长一点的 message / thinking / tool result 上很容易被截，UI 即便点了「展开」（移除 max-h-72 限制）也只看到截断后版本带 `[truncated XX bytes]` marker，用户主诉「展开后内容也不全」根源
- 64KB ≈ 2 万中文字符 / 6 万英文字符，覆盖绝大多数对话场景；与 256KB 总上限协调（最多 4 个 64KB 大字段）
- 极长（> 64KB 单字段）仍截并保留 marker，避免 GB 级 Bash 输出 / 文件 dump 撑爆 SQLite

### 测试

#### `src/main/session/__tests__/manager.test.ts`

- 新增 H1 case：「hook 抢先复活 OLD_ID（resume 路径）→ cwd 命中 pendingSdkCwds 即便 record 已存在也 skip+claim」
- 断言：record 仍 closed、source 仍 sdk、events 表无新增、`session-upserted` 没多余广播；后续同 id hook 也被 dedup
- 加完后 13/13 通过；全 vitest 38/38 通过

## 验证

```bash
pnpm typecheck   # ok
pnpm vitest run  # 38/38 (manager 13 + payload-truncate 12 + search-predicate 13)
```

改 main 进程，按 CLAUDE.md 必须重启 dev：

```bash
lsof -ti:47821,5173 2>/dev/null | xargs -r kill -9
pkill -f "electron-vite dev" 2>/dev/null
pkill -f "Electron.app/Contents/MacOS/Electron" 2>/dev/null
pnpm dev
```

## 备注

- 用户明确「ActivityFeed 默认折叠（800/600 阈值 + max-h-72/56 + 展开按钮）保留」+「SessionCard 80 字预览不动」，本次只动 main 进程 `MAX_FIELD_BYTES`，前端折叠逻辑零改动
- H4 修法对 SDK 默认 `resume: sessionId`（不 fork）路径完全收敛；如未来加 `forkSession: true` 选项，需要在 consume() 拿到 first id ≠ opts.resume 时把 OLD_ID 的 claim 释放转给 NEW_ID（当前不在范围内）
- 用户连点「恢复会话」启动多个 SDK query 是另一独立 bug（消息可能重复但仍是 OLD_ID 一份 record），本批不处理
- 关联 [REVIEW_5.md](../reviews/REVIEW_5.md)
