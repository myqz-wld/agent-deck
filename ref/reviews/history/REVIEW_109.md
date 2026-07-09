# REVIEW_109 — preload/api 残留 5 处契约专项 simple-review（Batch 11 9c67c120 收口）

> **全项目滚动 deep-review Batch 11（9c67c120 follow-up 收口）**。
> plan §174 + Batch 9 教训⑦ + Batch 10 已收口 main 端 9c67c120 主体债务（13 处 ipc/adapters.ts String() 裸 cast → parseStringId 替），剩 5 处 preload/api thin wrapper fp:NONE 真未审走轻量 simple-review 契约专项收口。
> 按 Batch 9 收尾 simple-review 范式（commit 6ec754c scope 6 文件同款）：单次异构对抗 + 三态裁决 + 必要 fix + 0 真问题 = 收口。

## scope（5 文件 724 LOC，0 改动）

- `src/preload/api/adapters.ts` (136/12fn)
- `src/preload/api/issues.ts` (79/6fn)
- `src/preload/api/misc.ts` (207/36fn)
- `src/preload/api/sessions.ts` (76/13fn)
- `src/preload/api/teams.ts` (133/14fn)

**已审 scope**（skip）：
- `src/preload/api/_helpers.ts`（R107 收尾 simple-review 已审）
- `src/preload/api/events.ts`（R45 审过 IPC channel scope，listener cleanup 同款范式在 _helpers.ts:25-32 已审）
- `src/preload/index.ts`（preload 入口聚合层）
- `src/shared/ipc-channels.ts` / `src/shared/types.ts` / `src/shared/mcp-tools.ts`（R107 收尾 simple-review 已审，类型 SSOT）

## 机器可读范围（File-level Review Expiry 用）

```review-scope
src/preload/api/adapters.ts
src/preload/api/issues.ts
src/preload/api/misc.ts
src/preload/api/sessions.ts
src/preload/api/teams.ts
```

## 三态裁决结果

### ❌ 无真问题

5 文件全量 full_review：双方 reviewer 共识 **0 HIGH / 0 MED / 0 LOW**。

### ❓ 部分 / 未验证

| 现场 | 视角 | 结论 |
|---|---|---|
| claude INFO `src/preload/api/adapters.ts:76` `CHANGELOG_<X>` 文档占位符未回填 | `git blame -L 76,76` = `e140b52b 2026-05-14`，**非本批 9c67c120 引入**，是 pre-existing 遗留；`grep -rn 'CHANGELOG_<X>' src/` = **55 处**系统性占位符（capabilities.ts / agent-adapter.ts / codex-cli 等同款）| **降 INFO follow-up**：不阻塞本批。codex sandbox 冷切真实编号疑为 CHANGELOG_54（_helpers.ts:108 `CHANGELOG_54 B-4` 指 codex SandboxMode union 落地同期）。**全局 doc-drift 清理统一处理**比单点修更合算 |

## 双方实战验证全景

| 维度 | 验证手段 | 结果 |
|---|---|---|
| **channel 覆盖（零孤儿）** | claude 脚本提取 5 wrapper 用到的 84 个 `IpcInvoke.*` + 2 个 `IpcEvent.*`，与 `src/main/ipc/*.ts` 全量 `on(IpcInvoke.X)` 注册集做 `comm -23` diff → **USED \ REGISTERED = ∅** | ✅ renderer 不会调到 undefined handler |
| **arg 序/数** | 逐 handler 比对 `ipcRenderer.invoke(ch, a, b, c)` ↔ `on(ch, (_e, a, b, c) =>...)`。adapters 12 / sessions 13 / issues 6 / teams 14 / misc 36 全部对齐（含 5-arg 的 RespondPermission/AskUserQuestion/ExitPlanMode/RestartWith*Sandbox）| ✅ |
| **return 形状** | handOffSummarize `{summary, sourceCwd, sourceAgentId, sourcePermissionMode}` ↔ wrapper 一致；restartWith{Codex,ClaudeCode}Sandbox `Promise<string>` ↔ agent-adapter.ts:88/100 接口确认；token-usage 3 handler `TokenRateRow[]/TokenDailyRow[]` 一致 | ✅ |
| **序列化边界** | invoke 入参（PermissionResponse / AskUserQuestionAnswer / ExitPlanModeResponse / ImageSource / UploadedAttachmentInput）+ 2 listener payload 全是 plain object / discriminated union，**无 function/Map/Set** | ✅ structured clone 安全 |
| **listener cleanup** | teams 2 个 `onAgentDeckXxxChanged` 都走 `subscribe<T>(channel, cb)` helper（_helpers.ts:25-32 `ipcRenderer.on` + return `ipcRenderer.off`）；grep 5 文件内**零裸 `ipcRenderer.on/removeListener`** | ✅ 无 cleanup 泄漏 |
| **类型自洽** | `pnpm typecheck`（tsc --noEmit ×2 project）**0 error** = channel key / arg type / return shape 全自洽硬证据；IssuesListFilters / IssuesUpdatePatch ↔ issues.ts zod schema 字段 1:1 | ✅ |
| **cast 守门** | 5 文件唯一 cast = misc.ts:35 `process.platform as NodeJS.Platform`（preload 注入的 Node 全局，合法）| ✅ **无 `as unknown` / `as any`** |
| **shared/types 枚举漂移** | sandbox 字面量 ↔ sandbox-config.ts + _helpers.ts 一致；permissionMode 4 档 ↔ PERMISSION_MODE_VALUES 一致；`capabilities: Record<string, boolean>` ↔ AdapterCapabilities 全 boolean 字段（capabilities.ts:6-58 逐项确认），widening 合法不丢契约 | ✅ |
| **payload 泛型** | teams `onAgentDeck{Team,Message}Changed` payload `{kind, teamId: string\|null, messageId, payload}[]` ↔ main bootstrap-wiring.ts:189 `makeDebouncedTeamSender<...teamId: string\|null...>` 逐字段对齐（含 teamless DM 的 `teamId: string\|null`）| ✅ |

## 收口判定

- **0 HIGH / 0 MED / 0 LOW / 1 INFO follow-up**
- **双方共识 + 实战验证可合**（claude 8 维度实战验证 + codex 5 文件全量读取 + `pnpm typecheck` 0 error 硬证据）
- diff: **0 改动**（5 文件全过）
- typecheck 双配置（tsconfig.node.json + tsconfig.web.json）**双绿**
- vitest 全量 **1450 passed / 238 skipped / 0 failed**（与 Batch 10 收口一致，0 回归）
- 9c67c120 follow-up: **本任务全部收口**（Batch 10 收 13 处 main 端 + Batch 11 收 0 处 preload 端因 5 文件 0 漂移）= **9c67c120 100% 关闭**

## 异构对抗高光

- **本批最大价值 = 实战验证广度**：claude 8 维度全跑通（含脚本提取 + comm diff + payload 泛型逐字段对齐 + typecheck 硬证据），远超 R107 同类 simple-review（commit 6ec754c 走「IPC 契约无漂移 + listener cleanup 全配套 + 序列化边界 + type 自洽 4 套 AssertSameKeys」4 维度同款验证强度）
- **双方共识 = 0 真问题不是「漏审」**：codex 报 0 finding + claude 实战验证 0 真修 = 双方都未发现真问题（不是单方漏审另一方抓出）；5 文件 0 改动是「可合」最强证据
- **claude 唯一 INFO 自我克制**：CHANGELOG_<X> 占位符 55 处系统性遗留 claude 自己 grep 实证 + git blame 实证非本批引入 + 建议「留全局 doc-drift 清理统一处理」= **不擅自扩 scope**的纪律示范

## follow-up（非阻塞）

1. **CHANGELOG_<X> 占位符全局清理**（claude INFO 升级）—— `grep -rn 'CHANGELOG_<X>' src/` 55 处同款遗留（capabilities.ts / agent-adapter.ts / codex-cli / preload/api/adapters.ts:76 等），属全局 doc-drift 清理专项。codex sandbox 冷切真实编号疑为 CHANGELOG_54（_helpers.ts:108 `CHANGELOG_54 B-4` 同期），可走 focused 简单 review 一次性回填
2. **issue 18041912**（Signal 1 shutdown race ingest→getDb DB-not-init）— 触及 before-quit/DB-lifecycle/ingest 热路径 REVIEW_104 加固区裂口，应走独立 focused deep-review 多轮
3. **preload/api 残留 thin wrapper handler 测试**（与 REVIEW_108 一样 = 0 测试覆盖）—— 0 改动但 0 测试的尴尬；如未来增测试可走 `__tests__/api/*.test.ts` 覆盖 channel 注册 + subscribe cleanup

## 任务到达维护期高点（plan §Batch 11 建议）

Batch 1-11 = 11 批主逻辑 + 4 批 simple-review 收尾 = **15 批 × ~100 个真修**。**高 ROI main 逻辑 + 9c67c120 follow-up 全部收口**。剩：
- thin wrapper 测试覆盖（专项）
- 全局 doc-drift 清理（专项）
- Signal 1 shutdown race（独立 focused deep-review）
- 用户需求驱动的新 feature/review

**下会话与用户确认**：
- 继续主动 deep-review（哪个方向？）
- 转 file-level expiry 驱动的常态化增量重审
- 停 + follow-up 路线
