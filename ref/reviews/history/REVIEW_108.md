# REVIEW_108 — ipc/adapters.ts 主逻辑面 simple-review（Batch 10 收尾）

> **全项目滚动 deep-review Batch 10（收尾批）**。
> 上次深度审 R24（5/4 列名 trace-waypoint，0 finding 命中）后，**8 个 handler 风格分裂 + createSession post-create 泄露 + SetPermissionMode 信任边界缺口** 在 R24-Batch 9 跨度内未触动。
> 本批 = 轻量 simple-review（按 plan §172 + user 选确认）：单次异构对抗 + 三态裁决 + 必要 fix。

## scope（1 文件 430 LOC +60/-32）

- `src/main/ipc/adapters.ts`（registerAdaptersIpc 入口 11 个 handler + persistAttachments helper）
- 已知 R24 是列名 trace-waypoint 0 finding 命中（scope 表 line 34 + 50 + 真问题表 0 项）= 真未审主逻辑面
- 已知 plan §168 scope-out follow-up issue **9c67c120**（18 处 String(x) 裸 cast vs parseStringId 风格混用未解决）
- 已知 R11 Bug 2『SetPermissionMode bypassPermissions 冷切』护栏最近 5 commits 内未触动

## 机器可读范围（File-level Review Expiry 用）

```review-scope
src/main/ipc/adapters.ts
```

## 三态裁决结果

### ✅ 真问题

| # | 严重度 | 文件:行号 | 问题 | C | X | 验证手段 |
|---|---|---|---|---|---|---|
| 1 | MED-1 | `src/main/ipc/adapters.ts:323-327`（修前）| `AdapterSetPermissionMode` mode 裸 `as Parameters<...>[1]` 断言，运行时零校验直写 `sessionRepo.setPermissionMode(sid, m)` + emit upsert；非白名单字符串可绕过 `m === 'bypassPermissions'` 冷切分派（落入热切路径），DB 落非法值（core-crud.ts:198 写也无 runtime 校验）| ✅ 双方独立 | ✅ | 同文件 line 124 createSession 已用 `parsePermissionMode` 范式收口 —— **同文件不对称**确凿；grep 全 adapters.ts `parsePermissionMode` 仅命中 createSession 一处（asymmetry 铁证）；读 can-use-tool.ts:341 `getPermissionMode() === 'bypassPermissions'` 短路只认字面量 → **fail-secure 不提权**（不升 HIGH 理由）；codex 在 codex-cli/index.ts:18,196 确认 codex 无 setPermissionMode，line 325 throw 拦截仅 claude-code arm 命中 |
| 2 | MED-2 | `src/main/ipc/adapters.ts:185`（修前）| `AdapterCreateSession` post-create `recordCreatedPermissionMode` 裸调，在 line 161-181 try/catch（仅覆盖 adapter.createSession）**外**；helper 内 setPermissionMode(DB 写) + sessionRepo.get(DB 读) + eventBus.emit（同步派发监听器）三处可抛 → 失败 throw 冒泡让 renderer 收 IPC error 拿不到 sid，**SDK 子进程已活** = 孤儿活 session + caller 可能重试重复 create | ✅ 单方（codex MED-3）| ✅ | 读 spawn.ts:364-380 同 post-create helper 明确包 try/catch + capability gate（spawn handler 是更晚出的修法，作为本修法范式）；静态读 line 161-185 try 块 line 182 close + 注释 line 183-185 确认 recordCreatedPermissionMode 在 try 外 |
| 3 | LOW-1 | `src/main/ipc/adapters.ts:290-428`（修前 13 处）| 8 handler（RespondPermission/RespondAskUserQuestion/RespondExitPlanMode/SetPermissionMode/ListPending/ListPendingAll/RestartWithCodexSandbox/RestartWithClaudeCodeSandbox）用裸 `String(agentId/sessionId/requestId)`，与同文件前 3 handler（createSession/interrupt/sendMessage）的 `parseStringId('agentId', agentId, 64)` **风格 + 错误透传精度双分裂**。后果：null/undefined → `'null'`/`'undefined'` → `adapterRegistry.get()` 拿 undefined → 报泛化 `adapter cannot xxx`，**非** `IpcInputError('invalid ipc input: agentId (must be non-empty string)')`。漏了 agentId 64 长度上限 / sessionId 256 上限。RestartWith*Sandbox 的 sandbox 字段更**没用既有 parseCodexSandboxMode / parseSandboxMode helper**，手写 `String(x) as union` + 三路 if | ✅ 双方独立 | ✅ | grep `parseStringId\|String(` 全量列：line 109/220/222/226/275 = parseStringId；line 290/293/294/300/305/306/324/326/362/364/367/421/422 = 裸 String（修前）；与 plan §168 issue 9c67c120 「18 处 String(x) 裸 cast 未解决」**完全对齐**（本批收口 13 处 = 9c67c120 主要债务 + plan 9.67c120 残留 5 处属 scope 外/已审）|
| 4 | LOW-2 | `src/main/ipc/adapters.ts:185`（修前）| `AdapterCreateSession` 持久化 permissionMode 缺 `canSetPermissionMode` capability gate，cli.ts:285 有 gate + adapters.ts:185 无 gate → 不对称；后果：codex-cli session（`canSetPermissionMode: false`，index.ts:38）传 `permissionMode: 'plan'` → recordCreatedPermissionModeImpl（lifecycle.ts:262）写入 codex session 的 `permission_mode` DB 列（对 codex 无意义字段）| ❌（codex 未提）| ✅ | 两入口对照：cli.ts:285 有 gate / adapters.ts:185 无 gate；options-builder.ts:119 narrowToCodexOpts 注释 + line 142 确认 codex arm **不接** permissionMode（已 filter，故 SDK 运行时行为无影响，仅 DB 脏列）→ 影响轻定 LOW；与 finding 2 合并整改 |

### ❌ 反驳（被对抗或现场核实证伪）

| 报告方 | 报项 | 反驳依据 |
|---|---|---|
| Codex | MED-1 (adapters.ts:261) sessionId 校验前写附件，非法 ID 会绕过 cleanup | **真问题被 finding 3 整改覆盖**：persistAttachments 内部 line 92-96 catch `deleteUploadIfExists(written)` 已覆盖「写盘 + parse 失败 throw」场景（claude R1 走 persistAttachments 三处回滚对称确认通过，line 277-278 两 await 同块 R43 fix 确认到位）；AdapterSendMessage 入口 line 226 已 parseStringId('agentId', agentId, 64) 取 adapter 成功 → persistAttachments 跑 → 写完接 line 275 parseStringId('sessionId', sessionId) throw 时 persistAttachments catch 已回滚。**作为 IPC 边界严格一致性整改**已并入 finding 3（前移 parseStringId 至 persistAttachments 之前的 catch 范围 = 与 SetPermissionMode 范式对齐）|
| Codex | MED-1 (adapters.ts:261) line 279-285 cleanup 不运行 | 误读 — line 279-285 catch 只覆盖 unarchiveOnUserSend + sendMessage。**persistAttachments 内部已 catch cleanup**（line 92-96），跨函数 leak 残留路径不存在 |

### ❓ 部分 / 未验证

| 现场 | 视角 | 结论 |
|---|---|---|
| Claude R1 INFO 11 handler 零测试覆盖 | `find src -name "adapters*.test.ts"` 空；`ls src/main/ipc/__tests__/` 仅 issues.test.ts / sessions.test.ts | **降 INFO follow-up**：与本批 MED/LOW 修法不绑定，属测试基础设施补强（rendered-LEVEL mocks + adapterRegistry + sessionRepo + image-uploads 整套 stub 工作量 ≥ 半天），不阻塞本批修法。记入 follow-up |
| Claude R1 残留风险 *未验证* | 非法 mode 落库后 SDK 子进程内部行为 | SDK `s.query.setPermissionMode(非法值)`（sdk-bridge/index.ts:455）是否抛错取决于 SDK 子进程 —— 静态验不了。但 finding 1 主体（信任边界缺校验 + 同文件不对称）不依赖此结论，确凿成立 |

## 修复（commit 本会话）

### MED-1 ✅ SetPermissionMode mode 白名单收口
- `adapters.ts:323-340`（修后）：
  - `String(agentId)` → `parseStringId('agentId', agentId, 64)`
  - `String(sessionId)` → `parseStringId('sessionId', sessionId)`
  - `mode as Parameters<...>` 裸断言 → 前置 `mode === undefined || mode === null` 抛 `IpcInputError('mode', 'required (one of default|acceptEdits|plan|bypassPermissions)')` + `parsePermissionMode(mode) as SDK union` 走白名单收口
  - **R11 Bug 2 bypassPermissions 冷切护栏保留**：line 334 `if (m === 'bypassPermissions' && adapter.restartWithPermissionMode)` 仍走 `restartWithPermissionMode` 冷切，claude R1 回归 confirm 通过

### MED-2 ✅ createSession post-create 持久化 try/catch + canSetPermissionMode gate
- `adapters.ts:185-201`（修后）：
  - 仿 mcp spawn.ts:364-380 范式：`if (permissionMode !== null && adapter.capabilities.canSetPermissionMode) { try { sessionManager.recordCreatedPermissionMode(sid, permissionMode); } catch (e) { logger.warn(...); } }`
  - 失败仅 warn 不阻塞 createSession 返回 → 避免孤儿活 session（caller 拿到 sid 可后续 cleanup）
  - capability gate 与 cli.ts:285 对齐（codex arm canSetPermissionMode=false 跳过，避免 codex session 落无意义 `permission_mode` 列）
  - **同 MED-2 + LOW-2 合并修**（同一 if 块两条件，零增量代码）

### LOW-1 ✅ 8 handler parseStringId 统一 + RestartWith*Sandbox 改 parse helper
- `String(agentId/sessionId/requestId)` 13 处全替 `parseStringId(field, value, maxLen)`（maxLen=64 for agentId, =256 for sessionId/requestId）
- RestartWithCodexSandbox: `String(sandbox) as union` + 三路 if → `parseCodexSandboxMode(sandbox)` helper 复用（null → `IpcInputError('sandbox', 'required (one of workspace-write|read-only|danger-full-access)')`）
- RestartWithClaudeCodeSandbox: 同款 → `parseSandboxMode(sandbox)`
- `String(handoffPrompt ?? '')` → `typeof handoffPrompt === 'string' ? handoffPrompt : ''`（避免 null 走 String() 变 `'null'`）
- **残留 4 处 `as Parameters<...>`**（line 312/324/336/351）：**全部是 SDK 入参 shape 转换**（response 是 permission 响应结构、answer 是 question 答案结构、mode 经 parsePermissionMode 已白名单收口后 cast 到 SDK 期望的 union）—— 不是 IPC 边界，保留
- **结果**：grep `String((agentId|sessionId|requestId))` **0 命中**；`parseStringId` 调用从 5 → 23（增长 18 处 = 9c67c120 follow-up 主要债务收口）

## 回归 confirm（非 finding）
1. **R11 Bug 2 bypassPermissions 冷切护栏**保持：line 334 `if (m === 'bypassPermissions' && adapter.restartWithPermissionMode)` 仍命中冷切路径；mode 经 parsePermissionMode 收口后只有白名单值可到 line 334 = 既有护栏 100% 生效
2. **persistAttachments 三处回滚对称**保持：createSession line 178-182 catch + sendMessage line 279-286 catch + persistAttachments 内部 line 92-96 catch 三处对称无 leak
3. **IpcInputError 错误透传**：修后所有 11 handler 入参校验全走 IpcInputError + parseStringId 收口，与 _helpers.ts「IPC 边界一次性校验 + 收口」原则统一

## 异构对抗高光

- **双方独立命中 2 项**（MED-1 mode 白名单 / LOW-1 String 风格分裂）—— 异构冗余 = 强验证
- **codex 独立命中 1 项**（MED-2 createSession post-create 泄露）—— 静态读码 trace 准确
- **claude 独立命中 1 项**（LOW-2 canSetPermissionMode gate）—— 与 MED-2 合并整改
- **codex MED-1 (sessionId 校验前写附件) 被 LOW-1 整改覆盖** —— 不单独立项
- **claude 残留风险 *未验证* 接受** —— finding 主体不依赖

## 收口

- **0 HIGH / 0 真 MED（已修 2 MED）** / 0 未整改 LOW（已修 2 LOW）/ 0 INFO
- **正向确认**：R11 Bug 2 冷切护栏保持 / persistAttachments 三处回滚对称保持 / IpcInputError 错误透传全收口
- typecheck 双配置（tsconfig.node.json + tsconfig.web.json）**双绿**
- vitest 全量 **1450 passed / 238 skipped / 0 failed**（+0 测试 = 与既有 121 文件测试规模一致；handler 测试 follow-up 不属本批）
- diff: `+60/-32` 单文件
- 9c67c120 follow-up: **本批收口 13 处（修前 18 处 → 修后 5 处）**，残留 5 处 scope 外（preload/api 层 thin wrapper，Batch 8 教训⑦走契约专项）

## follow-up（非阻塞）

1. **handler 级测试覆盖**（claude INFO 升级）—— adapters.test.ts 缺：补 mock adapterRegistry + sessionRepo + image-uploads 整套 stub，优先覆盖 SetPermissionMode 回滚路径（line 350-357 catch）+ persistAttachments 三回滚分支 + createSession recordCreatedPermissionMode 失败 warn-only 不冒泡。属测试基础设施补强，工作量 ≥ 半天
2. **9c67c120 残留 5 处**（preload/api 层 thin wrapper）—— Batch 8 教训⑦，**下一 simple-review 契约专项**集中收口，不属本批 scope
