# REVIEW_78 — 全项目 deep review 批 C4：claude-code sdk-bridge permission/tool/restart/cancel

- 日期: 2026-05-31
- 类型: Debug / 功能 BUG + 代码优化 + 文字措辞（全项目 deep review 第八批，Batch C 子批 C4，**Batch C 收官**）
- 触发: 用户「deep review 下项目，自主一路推进 + 自主 hand off」授权（plan deep-review-project-20260531）
- 关联: plan deep-review-project-20260531 / REVIEW_71-77（A1/A2/B1/B2/C1/C2/C3）
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，复用 C3 pair dr-project-c3-20260531）+ 三态裁决 + lead 全链 trace（getPermissionMode getter → internal.permissionMode → canUseTool bypass 短路 / closeSession interrupt→cleanup 时序 → consume finally 二次兜底）+ temp-revert 验证。
- 收口: R1 双 reviewer reply。**异构 divergence**：codex 2 MED（permission-responder hot-switch cache desync + pending-cancellation 不 resolve）；claude 0 HIGH / 1 MED（realSessionId 注释漂移）/ 4 INFO（含**显式反驳 codex MED-2** + 隐式 bless hot-switch try/catch）。lead 对两条 divergent MED 各自现场验证 → MED-1 确认真问题（互补盲点非反驳）→ fix；MED-2 lead 裁定 ❓→LOW（timing-dependent，最坏 GC'd 悬挂 promise 非资源泄漏）但 fix 为防御性 hardening（幂等无害）。comment-drift 双方独立（codex INFO×2 + claude MED）→ fix。typecheck 双配置 + sdk-bridge 78 passed（+5 回归 test，2 MED fix 全 temp-revert 验证各挂 2 test）。

## 范围（批 C4）

claude-code SDK adapter bridge 的「权限决策 + 工具回调 + 冷重启 + close cleanup」子模块，4 文件 ~1332 LOC：

| 文件 | LOC | 职责 |
|---|---|---|
| `sdk-bridge/can-use-tool.ts` | 400 | makeCanUseTool 工厂（READ_ONLY 白名单 / SandboxNetworkAccess auto-deny / AskUserQuestion / ExitPlanMode 走 UI / bypass 短路 / 默认权限请求 + 三类 pending 的 timeout timer + abort listener） |
| `sdk-bridge/permission-responder.ts` | 326 | respond Permission/AskUserQuestion/ExitPlanMode + 3 timeout + listPending/listAllPending（ExitPlanMode 4 档 resolver：approve+plan deny / approve 热切 allow / approve-bypass 冷切 / keep-planning） |
| `sdk-bridge/restart-controller.ts` | 467 | restartWithPermissionMode + restartWithClaudeCodeSandbox 冷重启（单飞 while(inflight) + session-renamed transfer recovering Map + jsonl fallback + 失败回滚） |
| `sdk-bridge/pending-cancellation.ts` | 139 | cancelPendingAndEmit（清三 pending Map + emit cancelled）+ runCloseSessionCleanup（三面 release/黑名单 + notify wakeup） |

## 三态裁决结果

### [MED ✅ codex + lead 验证] permission-responder.ts:140 — ExitPlanMode approve 热切档不同步 internal.permissionMode cache + 失败只 log

reviewer-codex 提出（claude 隐式 bless「热切 try/catch 吞错只 log ✓」= 互补盲点未审 cache 同步角度，非反驳）。`respondExitPlanMode` 的 approve + `{default|acceptEdits}` 分支直接调 `s.query.setPermissionMode()` + 写 DB + emit upsert，但**不写 `s.permissionMode`**，且失败只 `console.warn`。

```ts
// 修前
try {
  await s.query.setPermissionMode(response.targetMode);
  sessionRepo.setPermissionMode(sessionId, response.targetMode);
  const updated = sessionRepo.get(sessionId);
  if (updated) eventBus.emit('session-upserted', updated);
} catch (err) {
  logger.warn(`[sdk-bridge] hot-switch permission mode after approve failed: ${sessionId}`, err);
}
```

**lead 全链 trace 验证（确认真问题）**：
- `canUseTool` 的 `getPermissionMode()` getter = `() => internal.permissionMode`（create-session-impl.ts:137），唯一运行时读 cache 值的点是 bypass 短路 `getPermissionMode() === 'bypassPermissions'`（can-use-tool.ts:340）。
- 公共 `setPermissionMode`（index.ts:424-436）做：chain 串行化 + optimistic `s.permissionMode = mode` + `await query.setPermissionMode` + catch rollback。热切路径**完全绕过**这套语义。
- **3 个真实后果**：① cache 停留旧 `plan` → 违反 `sdk-message-translate.ts:196`「DB/UI ↔ internal cache 单一源」不变量 + 下次 `setPermissionMode` 读 `oldMode = s.permissionMode` 拿脏值当 rollback baseline；② 失败不回滚 DB → 用户已批准退 plan 但 DB 卡旧 mode；③ 失败无 error message → 用户不知切失败。
- **测试铁证**：`can-use-tool.test.ts:172-194` 专门测「热切换 setPermissionMode 等价：internal.permissionMode 更新后立刻按新 mode 短路」，手动 `internal.permissionMode = 'bypassPermissions'` 模拟正确契约 —— 证明 cache 同步是已确立的协议，热切路径违反它。
- **方向澄清**：热切 target 只能是 default/acceptEdits（bypass 走 approve-bypass 冷切 restart 路径），故 stale `plan` ≠ bypass，不直接造成错误 short-circuit allow；但 cache/DB/SDK 三分裂 + 失败静默是真隐患。

**修法**：补 optimistic `s.permissionMode = response.targetMode`（await 前，与 index.ts:427 同款 fail-secure 时序）+ catch 回滚 cache 到 oldMode + emit 用户可见 error（与 restart-controller 失败回滚同款）。+3 回归 test（成功 cache 同步 / 失败回滚+error / plan 分支早返不动）。

### [LOW ✅ codex 提 MED → lead 裁 LOW（仍 fix 防御性 hardening）] pending-cancellation.ts:37 — close cleanup 清 pending Map 但不 resolve SDK promise

reviewer-codex 提 MED；**reviewer-claude 显式反驳为非 bug**（论证 closeSession 先 `await query.interrupt()` 同步驱动 can-use-tool abort listener resolve → cancelPendingAndEmit 时 Map 已空）。lead 裁决：

**lead 全链 trace 验证（裁定 ❓→LOW + 仍 fix）**：
- `closeSession`（index.ts:368-385）：`expectedClose=true` → `await query.interrupt()` → `runCloseSessionCleanup` → `cancelPendingAndEmit` 清三 Map（无 resolver 调用）。
- 释放 canUseTool promise 的两个 backstop：① abort listener（can-use-tool.ts:183/303/380，`if(cur){...resolve}`）② consume() finally（stream-processor.ts:422-440，iterate values resolve 后 clear）。
- **claude 的论证依赖「`await interrupt()` 同步驱动 ctx.signal abort」** —— 但 SDK `interrupt()` 的 abort 同步性**未契约保证**（minified SDK 无法实证）。若 abort 在 `await interrupt()` 返回后 async fire → cancelPendingAndEmit 先 clear Map → abort listener 与 consume finally **都** iterate 空 Map（cleanup 已 `.clear()`）→ canUseTool promise 不被 resolve。
- **裁定 LOW 而非 MED**：worst-case harm = 一个 GC'd 悬挂 promise（internal 已从 sessions Map 移除 + GC；timer 已被 `clearTimeout` 清 —— 无 timer/handle 资源泄漏，仅语义不洁）。claude 论证的时序通常成立，只是不能契约保证。
- **仍 fix 理由**：让释放责任不依赖 interrupt 同步性（防御性），且 fix 幂等无害（Promise resolve 首次 settle 后续 no-op，与 abort listener / consume finally 任一先 resolve 不冲突）。

**修法**：`cancelPendingAndEmit` 对三类 entry emit cancelled 后 best-effort 调 `entry.resolver`（语义对齐 consume finally：permission→deny+interrupt / ask→__session_ended__ / exitPlan→keep-planning）。+2 回归 test（resolve 被调 / 幂等无冲突）。

### [INFO ✅ 双方独立] realSessionId 注释字段漂移（can-use-tool.ts:43 + pending-cancellation.ts:28-29,81-82）

reviewer-codex（INFO×2）+ reviewer-claude（MED，grep 5 处实证）**双方独立**提出。`realSessionId` 字段 types.ts:104 已 rename 成 `cliSessionId`（双轨 applicationSid/cliSessionId），但 3 处生产注释 + jsdoc 仍按旧字段名 + 旧兜底语义（`realSessionId ?? sessionId`）描述。

**lead 验证**：
- can-use-tool.ts:43 注释「createSession 阶段 internal.realSessionId 还没拿到 → 用 tempKey 兜」；实际 getSessionId() 返 `internal.applicationSid`（spawn 期初值 tempKey，first realId 后冻结）。
- pending-cancellation.ts:28-29 jsdoc `realIdForEmit（realSessionId ?? sessionId 兜底）`；实际 caller 传 `internal.applicationSid`（:101）。
- pending-cancellation.ts:81-82 jsdoc step 3/4「releaseSdkClaim/markRecentlyDeleted sessionId / realSessionId」**两面**；实际是**三面**（sessionId/applicationSid/cliSessionId，:107-127）—— 尤其误导。

**修法**：can-use-tool.ts:43 改述 applicationSid spawn/resume 双阶段语义；pending-cancellation.ts 28-29 jsdoc 随 MED-2 fix 重写 + 81-82 step 3/4 改述三面 release/黑名单。纯注释，保留 :114「替代 internal.realSessionId ?? sessionId」历史锚点（OLD→NEW 迁移描述）。

## 其余 finding（claude INFO，lead 复核）

### [LOW ❓ 测试盲区] can-use-tool abort listener / 同步预检 aborted 分支零单测覆盖（claude）
REVIEW_35 R2 MED-rF-1 的核心修法（三类 pending 同步预检 `ctx.signal?.aborted` + abort listener delete+resolve）无回归 test。本轮 C4 fix 不直接覆盖此盲区（MED-1/MED-2 fix 测的是 responder + cancelPendingAndEmit），保留为 follow-up 测试盲区（不阻塞合并）。

### [INFO ✅ by-design] respond*/timeout/abort listener 三方 delete 竞争幂等（claude 验证非 bug）
三方都走 `pending*.get(requestId)` 不存在早返 + Node 单线程 + Promise resolve 幂等 → 安全收敛。lead 复核同意。

### [INFO ✅ 全部正确] ExitPlanMode 4 档 + bypass 短路插点 + 协议一致性（claude 逐项 ✓）
4 档 resolver 互斥正确（与 responder 配对）/ bypass 短路插在特殊工具分支之后不绕开 SandboxNetworkAccess/AskUserQuestion/ExitPlanMode / getSessionId lazy getter / setPermissionMode chain race-free / restart 单飞 while(inflight) + session-renamed transfer Map entry + finally off listener / 措辞清晰无占位残留。lead 复核同意。

## 验证

- `pnpm typecheck`（tsconfig.node.json + tsconfig.web.json 双配置）✓ exit 0
- `vitest run src/main/adapters/claude-code/sdk-bridge/__tests__/` → **11 files / 78 passed**（73 + 5 新）✓
- **temp-revert 验证**（2 MED fix 各自非回归）：
  - MED-1 revert（移除 cache sync + rollback + error emit）→ 2 test 挂（cache 不同步 / 失败不回滚）
  - MED-2 revert（移除 3 处 best-effort resolver）→ 2 test 挂（resolver 未调 / 幂等）
- 新增 test：`exit-plan-hotswitch-and-cancel-resolve.test.ts`（5 test：MED-1 ×3 + MED-2 ×2）

## 结论

C4 子批 **2 真问题 fix**（MED-1 hot-switch cache desync 确认真问题；MED-2 裁 LOW 但仍防御性 fix）+ 3 处注释漂移修正（双方独立）。**Batch C（claude-code sdk-bridge 全 27 文件）收官** —— C1-C4 累计 8 bug fix（C1 3 / C2 2 / C3 0 / C4 2，+ C3/C4 注释精确化）+ 系统覆盖会话创建 / recovery / 流消费 / 权限 / 重启全链路。typecheck 双配置 + sdk-bridge 78 passed。
