# CHANGELOG_34: ExitPlanMode 批准 bypass 不再弹红字 + 不再多出 cli source 孤儿会话

## 概要

修 CHANGELOG_33 落地后用户报的两条体感 bug：
1. plan 模式批准 ExitPlanMode 选「完全免询问（bypassPermissions）」会先弹一条红字「⚠ SDK 流中断：Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use」，再切到 bypass。明明是设计内的「主动 interrupt + 主动重启」（REVIEW_8 HIGH-1 论证过 deny+interrupt:true 是规避 jsonl flush race 的必要手段），UI 却像系统崩了。
2. 同场景下 SessionList 多出一条带 cli 标签的孤儿会话——OLD_ID 被 renameSdkSession 物理 DELETE 后，OLD CLI 子进程 SIGTERM 后异步飞的迟到 SessionEnd hook 进 ingest 时三道兜底全失效（sdkOwned 已 release、sessionRepo.get OLD_ID 已不存在、cwd 兜底已被一次性 consume），ensureRecord 用 source='cli' 复活成新 record。

修法：InternalSession 加 `expectedClose` flag 让 query loop catch 块识别"应用主动关闭副产品"+ renameSdkSession 把 fromId 加进 `recentlyDeleted` 60s 黑名单让迟到 hook 被 ingest 入口直接丢弃。

## 变更内容

### 主进程（src/main）

#### `adapters/claude-code/sdk-bridge.ts`
- `InternalSession` interface 新增可选 `expectedClose?: boolean`：应用层主动关闭/重启该 session 的标记。
- `respondExitPlanMode` 进入 `approve-bypass` 分支后、`entry.resolver(response)` 之前置 `s.expectedClose = true`：resolver 即将返回 `{behavior:'deny', interrupt:true}` 触发 SDK 内部 `[ede_diagnostic]` 状态机不一致诊断错误，flag 让 catch 认出来不弹红字。
- `closeSession` 入口 `await internal.query?.interrupt?.()` 之前置 `internal.expectedClose = true`：双保险，覆盖所有应用主动关闭入口（SessionManager.delete / restartWithPermissionMode 冷切 / 应用退出清理等）。
- `consume()` query loop catch 块判 `internal.expectedClose === true` 时降为 `console.warn`，不再 emit「⚠ SDK 流中断」红字 message；finally 兜底清理（emit `*-cancelled` + `session-end` + 清 pending Maps + releaseSdkClaim）路径不变。
- 不依赖 SDK 错误字符串匹配（CLAUDE.md 反复强调的 P12 教训）。

### 会话层（src/main/session）

#### `manager.ts`
- `renameSdkSession(fromId, toId)` 在 `sessionRepo.rename(fromId, toId)` 之后立即 `this.recentlyDeleted.set(fromId, Date.now())`：跟 `SessionManager.delete` 同等对待——rename 走 INSERT NEW + DELETE OLD 路径，OLD_ID 在 DB 已不存在，60s 内的迟到 hook event 应该被 ingest 入口 `isRecentlyDeleted` 直接丢弃，不进 `ensureRecord` 复活成 source='cli' 的孤儿。
- 覆盖所有 rename 场景：SDK fallback 的 `tempKey→realId`、CLI 隐式 fork 的 `OLD→NEW`、bypass 冷切的 close+restart。

## 备注

- 双对抗（Claude general-purpose Opus 4.7 xhigh + Codex gpt-5.5 xhigh）见 `reviews/REVIEW_9.md`：根因 a+b+c 链路 + 修法 D' (expectedClose) + 1B (rename 加黑名单)，双方一致采纳。
- expectedClose flag 不需要清：internal session 紧接着会被 sessions Map 删除（closeSession line ~1100 `this.sessions.delete(key)`），下次 createSession 起新的 internal 不带 flag。
- recentlyDeleted 黑名单的 60s ttl 跟原 SessionManager.delete 用法对齐，足够覆盖 OLD CLI 子进程从 SIGTERM 到完全退出 + 最后 hook event 抵达 hook-server 的最长延迟。
- 选择方案 1B 而非 Codex 推荐的方案 1（restartWithPermissionMode 入口提前 expectSdkSession）：1B 利用现有 recentlyDeleted 机制，零新增基础设施 + 适用所有 rename 场景 + 不受 cwd 兜底一次性 consume 限制（OLD CLI 飞多条迟到 hook 都能接住）。
