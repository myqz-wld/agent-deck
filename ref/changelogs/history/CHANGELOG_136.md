# CHANGELOG_136 — sessions.id 稳定化（反向 rename 设计）

## 概要

Plan `reverse-rename-sid-stability-20260520` 收口。修复跨 6 处反向 rename 路径(jsonl-missing fallback × 2 / fork detect × 2 / restart-controller × 2)下 `sessions.id` 不稳定导致下游 12+ 子表 cascade rename + token map / sessions Map / events / file_changes / summaries 跨表迁移 + reviewer teammate `send_message` 撞 not found 等连锁问题。

**核心思路**:`sessions.id` = applicationSid 永不变(对应应用层 events / mcp token / wire prefix `[sid]` 的稳定 key);新加 `sessions.cli_session_id` 列承载 SDK / CLI thread sid(允许变化)。bridge 内部 InternalSession metadata 双阶段化(applicationSid + cliSessionId 两字段)— spawn 主路径 ctor 时 = tempKey,first realId 后切到 realId 后冻结;resume / fallback 路径 ctor 时 = opts.resume,全生命周期不变。

## 设计骨架

8 个设计决策 + 5 不变量 + Step A/B/C 三阶段 ship,经 **plan Round 1-8 八轮 deep-review** 双方共识 ✅ 收口(0 真 HIGH 0 真 MED + 3 LOW non-blocking implementation-time tweak)。详 plan §设计决策 D1-D8 + §不变量 5 条 + §spike-reports 4 个 mini-runner 实证。

## 关键不变量

- **N1** sessions.id 永不变(applicationSid 维度)— spawn 主路径 first realId 切到 realId 后冻结(D2 spawn bootstrap rename 保留),resume / fallback 路径 ctor 时 = opts.resume 全生命周期不变
- **N2** cli_session_id 列承载 SDK / CLI thread sid 允许变化 — 6 处反向 rename 路径下走 `sessionManager.updateCliSessionId(applicationSid, newCliSid)` 单列 UPDATE
- **N3** wire prefix `[sid <appSid>]` 100% 写 sessions.id(应用层稳定 key);events / file_changes / summaries 等子表 session_id 列等于 applicationSid 永不变迁
- **N4** mcp token map key = sessions.id 维度 — 反向 rename 不动 sessions.id → token 永远稳定
- **N5** 迟到 hook event 黑名单 60s — `sessionManager.updateCliSessionId` 内部读 OLD_CLI_ID + `recentlyDeleted.set(oldCliSid, 60s)` 防迟到 hook event 携带 OLD_CLI_ID 复活幽灵 record;ingest 入口 4 态分流(3a findByCliSessionId / 3b 黑名单 drop / 3c pendingSdkCwds claim+skip / 3d ensureRecord 建外部 CLI 会话)

## 实施 6 sub-commit chain

| sub-commit | 范围 | commit hash |
|---|---|---|
| **A-1** | schema migration v021 + sessionRepo cli_session_id 字段接入 + findByCliSessionId / updateCliSessionId helper | `579f934` |
| **A-2** | ingest 4 态分流 + 黑名单双写 (manager.ts 改造) | `d4e5ed7` |
| **A-3** | bridge identity split S1+S2+S3+S4+S4b atomic (InternalSession 重构 + sessions Map + event sid + handle return + provider/getter 5+ 处) | `ad12ea4` |
| **A-4** | bridge identity split S5+S6+S6.5+S8+S9 atomic (createSession return + fork detect 比较 + jsonl-missing fallback 重写 + finalizeSessionStart 函数签名 applicationSid + cliSessionId 双入参) | `613019b` |
| **A-5** | 测试矩阵收口 + S3 ctor sessions Map key 修正 (`this.sessions.set(internal.applicationSid, internal)`,resume 路径 sessions Map key 修正) + stream-processor.ts S3 三分支补全 fresh-cli-reuse-app 路径 sessionManager.updateCliSessionId 调用 + 测试基建升级 | `9225d59` |
| **C** | restart-controller 反转 (claude restartWithPermissionMode + restartWithClaudeCodeSandbox + codex restartWithCodexSandbox 三方法对称改造): RestartCreateOpts 加 resumeCliSid 字段 (R3 MED-R3-2) + 删 `if (newRealId !== currentSid) renameSdkSession` 块 + `return newRealId` → `return currentSid` (applicationSid 稳定);新增 3 test 验证双轨入参 | `a33b9b6` |

(Step B verify-only,fork detect 改造已含在 A-4 atomic patch;§B 节作为独立 commit boundary 仅 verify 不重复修改)

## 修法范围

**6 处反向 rename 路径**(D2 设计决策定稿):

1. claude jsonl-missing fallback (`recoverer.ts:466`) — `createSession({resume: applicationSid, resumeMode: 'fresh-cli-reuse-app'})` 让 SDK 起 fresh CLI thread 但复用 applicationSid;first realId 通过 `sessionManager.updateCliSessionId` 写库
2. codex jsonl-missing fallback (`recoverer.ts:339`) — 同款修法
3. claude streaming fork detect (`stream-processor.ts:354`) — 比较 `effectiveResumeCliSid !== realId` 触发 → `sessionManager.updateCliSessionId(applicationSid, realId)` (替代旧 `renameSdkSession(OLD, NEW)` cascade rename)
4. codex thread-loop case 3 fork detect (`thread-loop.ts:263`) — 同款修法
5. claude restartWithPermissionMode (`restart-controller.ts:171`) — `createSession opts` 加 `resumeCliSid: rec.cliSessionId ?? currentSid` 双轨入参 + 返 `currentSid` 不再返 newRealId
6. claude restartWithClaudeCodeSandbox (`restart-controller.ts:316`) — 同款修法

**SSOT 接口拆分**:
- `applicationSid` (D7 不变量 1):sessions.id 维度,events.session_id / mcp token / wire prefix [sid] / sessions Map key 全用此
- `cliSessionId` (D5 jsdoc 双阶段化):SDK / CLI thread sid 维度,SDK options.resume + jsonl preflight stat path 用此
- `effectiveResumeCliSid` (S1 R6 升级 bridge 内部 resolver):3 分支 guard `opts.resumeMode === 'fresh-cli-reuse-app' ? undefined : !opts.resume ? undefined : (opts.resumeCliSid ?? sessionRepo.get(opts.resume)?.cliSessionId ?? opts.resume)`
- `resumeMode: 'resume-cli' | 'fresh-cli-reuse-app'` (R3 HIGH-G 修订):显式 mode 字段触发 jsonl-missing fallback 路径 (SDK 不带 resume 起 fresh CLI thread + 复用 applicationSid)

**InternalSession 字段命名升级**:`realSessionId` → `cliSessionId` (字面 rename 反映 cli sid 维度) + 新增 `applicationSid` (双阶段生命周期 — spawn 路径 first realId 后冻结 / resume 路径全程不变)

## 测试覆盖

**新增 / 更新测试**(Step A-5 + Step C):

- claude/__tests__/sdk-bridge.consume-fork.test.ts: `applicationSid + cliSessionId` 字段接入 + 反向 rename 修订断言 (`updateCliSessionId(applicationSid, NEW_ID)` 替代旧 `renameSdkSession`)
- codex/__tests__/sdk-bridge.consume-fork.test.ts: case 3 反向 rename 修订 (sessions Map key 不变 + updateCliSessionId)
- claude/__tests__/sdk-bridge.recovery.test.ts (5 case): jsonl missing + cwdFellBack + 摘要 + B.4 并发 sendMessage 全更新 (resume + resumeMode 双轨字段)
- codex/__tests__/sdk-bridge.recovery.test.ts (3 case): 同款更新
- claude/sdk-bridge/__tests__/restart-controller-fork-rename.test.ts: 新增 3 case 验证 §C.1 R3 MED-R3-2 (resume + resumeCliSid 双轨入参 + cliSessionId === null 兜底场景)
- 测试基建: `_shared/mocks/session-repo.ts` 加 findByCliSessionId / updateCliSessionId default impl;TestBridge CreateSessionCall 加 resumeMode 字段 + 新增 interceptSkipFirstCalls 计数 (反向 rename 后 p1/p2 用同 sid 进 recoverer)

**最终验证**:
- `pnpm typecheck` ✓ 0 errors
- `pnpm build` ✓ main + preload + renderer 全过
- `pnpm exec vitest run` ✓ 811 passed | 83 skipped (75 files)

## 八轮 deep-review

`reverse-rename-sid-stability-20260520` plan 经 plan-review SKILL kind='plan' 八轮异构对偶(reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5)累计 ~40+ 项 fix:

- R1: 3 HIGH + 6 MED 应用修订
- R2: §A.4-pre 升级为「bridge identity split」9+1 substep S1-S10 (codex HIGH-D + HIGH-E)
- R3: HIGH-F applicationSid 双阶段化 + HIGH-G resumeMode 字段 (codex 反驳轮 +)
- R4: HIGH-R4-1 S3 字面 isNewSpawn 分支保护 + HIGH-H applicationSid 贯穿覆盖扩展 5+ 处 + sub-commit 划分调整 + S1 7 种合法/非法组合不变量表
- R5: HIGH-R5-1 S3 与 S6 时序漏洞 (R4 fix 引入) + MED-R5-1 pending-cancellation 路由
- R6: 双方独立同款 HIGH-R6-1 normal resume `resumeCliSid` 缺失让 S6 fork detect 失效 + 互补 caller 矩阵审计 (S11)
- R7: HIGH-R7-1 effective resolver 三分支 guard opts.resume + 2 MED (Step B.1 stale + test 6 黑名单断言不对称)
- R8: 双方 0 HIGH + 0 MED + 「可合」共识 + 3 LOW non-blocking implementation-time tweak

详归档 plan [`plans/reverse-rename-sid-stability-20260520.md`](../../plans/history/reverse-rename-sid-stability-20260520.md) §设计决策 D1-D8 + §不变量 5 条 + §spike-reports 4 个 mini-runner 实证 + Step A.5 R1 MED-D test 1-17 完整矩阵覆盖。
