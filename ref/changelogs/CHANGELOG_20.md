# CHANGELOG_20: 双对抗架构评审 Phase 0 — 两个 H 级隐患修复

## 概要

按 `~/.claude/plans/cheeky-twirling-petal.md` 的双对抗架构评审推荐路线 Phase 0，修两个被对抗补出的 H 级真盲点：DB payload 无大小上限（长会话破 GB 风险）+ delete 会话不 abort SDK live Query（子进程继续跑 + pending Maps 不清）。

## 变更内容

### `src/main/store/payload-truncate.ts`（新增）

- `safeStringifyPayload(payload)`：序列化前先 shrink 已知大字段（`toolResult` / `output` / `stdout` / `stderr` / `content` / `text`，以及 `toolResult` 数组里 element 的 `text`），单字段截到 8KB；整体仍 > 256KB 降级为 marker payload（`__truncated: true` + `__originalBytes` + `__keys` + `__preview` 4KB 头）。深度限制 3 层避免 cycle。
- `safeTruncateBlob(blob)`：file_changes 表 before_blob / after_blob 已是 string，按 256KB 上限直接尾切并标 `[truncated N chars]`。
- `PAYLOAD_LIMITS` 常量导出，便于测试与诊断。

### `src/main/store/event-repo.ts`、`src/main/store/file-change-repo.ts`

- `eventRepo.insert` 走 `safeStringifyPayload(event.payload)`，替代 `JSON.stringify(event.payload ?? null)`。
- `fileChangeRepo.insert` 的 `beforeBlob` / `afterBlob` 走 `safeTruncateBlob`；`metadata` 走 `safeStringifyPayload`（防御性兜底，实际 metadata 一般 < 1KB）。

### `src/main/adapters/types.ts`

- `AdapterCapabilities` 加 `canCloseSession: boolean`。
- `AgentAdapter` 加可选 `closeSession?(sessionId): Promise<void>`，注释明确「与 interruptSession 区别」「不抛错」「由 SessionManager.delete 调用」。

### `src/main/adapters/{aider,generic-pty}/index.ts`

- 占位 adapter 的 capabilities 补 `canCloseSession: false`。

### `src/main/adapters/claude-code/index.ts` + `claude-code/sdk-bridge.ts`

- `capabilities.canCloseSession: true`，adapter 加 `async closeSession(sessionId)` 转发 bridge。
- `ClaudeSdkBridge.closeSession`：扫 `sessions` Map（key 可能是 tempKey 或 realSessionId），对找到的 internal session 做：
  1. `await query.interrupt()`（abort SDK 主流，让 ctx.signal propagate 到 canUseTool 链路）
  2. 兜底 clearTimeout 三张 pending Maps 的 timer 并 clear
  3. `sessions.delete(key)`
  4. `sessionManager.releaseSdkClaim(sessionId)`（含 realSessionId 别名）
  5. 唤醒 `internal.notify` 让 `createUserMessageStream` 在下次循环检查 `sessions.has(key) === false` 后 return

### `src/main/adapters/codex-cli/index.ts` + `codex-cli/sdk-bridge.ts`

- `capabilities.canCloseSession: true`，adapter 加 `async closeSession(sessionId)` 转发 bridge。
- `CodexSdkBridge.closeSession`：取 internal → `currentTurn?.abort()` + 清 pendingMessages → `sessions.delete(sessionId)` → `releaseSdkClaim`（含 threadId 别名）。

### `src/main/session/manager.ts` + `src/main/index.ts`

- `manager.ts` 加 `setSessionCloseFn(fn | null)` setter + `sessionCloseFn` 模块状态。SessionManager 仍**不直接 import adapterRegistry**（保单职责），通过 setter 注入。
- `manager.delete(sessionId)`：先 `sessionRepo.get(sessionId)` 拿 `agentId`，**fire-and-forget** 调 `sessionCloseFn(agentId, sessionId)`（不 await，避免 IPC 路径阻塞 renderer 等子进程退出；catch 只 warn——DB 行不能因为 SDK 那边回收失败而留着，孤儿状态更糟）；再 `sessionRepo.delete` + `eventBus.emit('session-removed')`。
- `index.ts` bootstrap 在 `adapterRegistry.initAll` 之后调 `setSessionCloseFn(async (agentId, sessionId) => adapterRegistry.get(agentId)?.closeSession?.(sessionId))`。

## 验证

- `pnpm typecheck` ✅ 通过
- 后续手测（用户重启 dev 时验证）：
  - **N1**：用 Bash 工具触发大 toolResult（如 `cat /var/log/system.log | head -10000`），DB 体积可控、UI events 列表里看到 `__truncated` payload 而非死锁
  - **N2**：开 SDK 会话执行长 Bash → 前端点删除 → 用 `ps aux | grep claude` 确认子进程真退出 + 重新发起同 cwd 会话不被旧 sdkOwned 误吞

## 备注

- 不删 `sessionManager.delete` 后的 `eventBus.emit('session-removed')`：renderer 需要这个事件触发 store 清理 by-session Map 7 张表（CHANGELOG_47 修过）
- `closeSession` 调 `releaseSdkClaim` 兜底 realSessionId 别名：避免 createSession 失败但已经 claim 过的 cwd 永远卡 sdkOwned
- 后续 Phase 1-4 见 plan 文件
