---
plan_id: "restart-controller-jsonl-precheck-20260521"
created_at: "2026-05-21T17:55:00+08:00"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/restart-controller-jsonl-precheck-20260521"
status: "completed"
base_commit: "619dca7"
base_branch: "main"
final_commit: "b44beb042c04b8cad8bc77a855ae33d206f7a224"
completed_at: "2026-05-21"
---
# Plan: restart-controller jsonl 预检与 recoverAndSend 路径对称

## 总目标

修复 ExitPlanMode bypass / 切 sandbox 档撞 "No conversation found with session ID: <sid>" 错误。

**根因**：`src/main/adapters/claude-code/sdk-bridge/restart-controller.ts:84` (restartWithPermissionMode) + `:254` (restartWithClaudeCodeSandbox) 两条**冷重启**路径直接调 `createSession({resume: currentSid, ...})` **没做 jsonl 预检**，与 `recoverer.ts:378` (recoverAndSend) 路径**不对称**。jsonl 不在时 CLI hard fail "No conversation found"，catch 回滚 DB + emit error message — 用户体验糟（重发后 Claude 失 plan 上下文，cold start 重新理解）。

**实测铁证**：本次错误 SID `27f48808-31eb-4920-b7c2-626fb469c8fb` 的 jsonl 用 `find ~/.claude/projects -name "*<sid>*"` 0 命中（jsonl 缺失）→ ExitPlanMode bypass 撞错。

**修法目标**：让 restart-controller 两条 restart 路径与 recoverAndSend 同款 — jsonl 预检 + 缺失走不带 resume 的 fresh CLI thread + 复用 applicationSid（resumeMode='fresh-cli-reuse-app'）。

## 不变量

1. **行为对称**：restart-controller 两条 restart 路径 + recoverer.recoverAndSend 三条都先 jsonlExistsThunk 预检（reuse 同一 thunk 实现 / 同一 type `JsonlExistsThunk` from recoverer.ts:138）
2. **jsonl 缺失走 fresh-cli-reuse-app**：用 ClaudeCreateOpts.resumeMode='fresh-cli-reuse-app'（index.ts:186 已支持），SDK 起 fresh CLI thread + 复用 applicationSid（不创建 NEW sessions row + 不撞唯一索引）
3. **applicationSid 全程不变**：fallback 路径 currentSid（== applicationSid）保持不变；CLI fork detect 走 stream-processor S6 内部 sessionManager.updateCliSessionId 单点 UPDATE cli_session_id 列（与正常 resume 路径同款，不依赖 fallback 显式 rename）
4. **fail-safe**：jsonlExistsThunk 任意异常返 true 让 createSession 自己 try（与 defaultResumeJsonlExists fail-safe 一致 — recoverer.ts:662-671）
5. **DB 回滚正确**：fallback 路径失败时 DB 回滚 oldMode/oldSandbox + emit error message + throw（与现有 catch 块 line 206-225 / 351-374 同款）
6. **handoffPrompt 仍非空校验**：fallback 路径仍校验 prompt.trim() 非空（与现有 line 89-91 / 260-264 同款）
7. **测试覆盖**：jsonl 缺失走 fallback 不抛错 + DB 改 mode/sandbox 持久化 + DB 回滚（异常路径）+ jsonlExistsThunk 异常 fail-safe 退化原行为
8. **现有正常 resume 路径不退化**：jsonl 在时仍走 line 182-198（restartWithPermissionMode）/ line 331-346（restartWithClaudeCodeSandbox）原路径不变
9. **fallback 路径不调 finalizeSessionStart**（plan-review Round 1 reviewer-claude MED-F1-1 + Round 2 reviewer-codex HIGH-1 升级修法）：fallback 走 ctx.createSession 时 opts.resumeMode='fresh-cli-reuse-app'，**createSession 内部新增 resumeMode guard**（`if (opts.resumeMode !== 'fresh-cli-reuse-app') finalizeSessionStart(...)` — index.ts:419-428 修改），跳过 finalizeSessionStart 创建新 sessions row + 跳过 emit session-start + 跳过 setClaudeCodeSandbox / setModel / setExtraAllowWrite + 跳过 emit 首条 user message（避免双 emit 撞唯一索引或 UI 看到「会话又创建了」）；fresh fallback 路径仅依赖 stream-processor.ts:336-342 内部 `sessionManager.updateCliSessionId` 单点 UPDATE cli_session_id 列（与 recoverer.ts:455-490 同款契约 / session-finalize.ts:31/41/74 jsdoc 明文契约 — **本 plan 完整实施 R6 MED-R6-1 修订**让 jsdoc 与 runtime 一致 / 不变量 3 applicationSid 全程不变 依赖此契约成立）
10. **fallback opts 硬约束 omit resumeCliSid**（plan-review Round 1 reviewer-codex MED-1 修法）：fallback 路径调 ctx.createSession 时**禁传** resumeCliSid 字段（与 resumeMode='fresh-cli-reuse-app' 组合是 types.ts:121-133 列举的 7 种合法/非法组合表中的 **runtime guard reject** 非法组合）。caller 必须显式 omit（不写在 opts 对象内 / 不传 undefined 也可，但建议直接不写让代码意图清晰）。测试 T2/T3 加断言：`expect(createSessionSpy.lastCall.firstArg).not.toHaveProperty('resumeCliSid')`
11. **helper 副作用归属契约 — 区分 fallback info message / user message / error message 三类 emit**（plan-review Round 2 reviewer-claude MED-F3-3 + Round 3 reviewer-codex HIGH-1 + **Round 4 reviewer-codex HIGH-1** 修法）：
    - **`maybeJsonlFallback` helper 必须 emit 系统侧 fallback info message**（按 §D4 三轴矩阵 6 文案 — emitContext × cwdFellBack × summary used/failed；非 error 信息提示用户「⚠ jsonl 不存在...」类原因）— **R4 codex HIGH-1 修订修法**：原 R3 修法写「caller catch 块 emit fallback message」是**设计错** — caller catch 只看到异常（recoverer.ts:546-559 + restart-controller.ts:206-225 / 351-369 现行 catch 仅 emit error message + rethrow），**看不到成功 fallback path** 的 6 文案 → 用户在 happy fallback path 看不到任何「为什么 fresh CLI 起来了」的提示。修法：helper 自己内部按三轴选 builder emit（与 recoverer.ts:398-437 现行行为对齐 — 4 文案在 happy fallback path emit 而非 catch）
    - **`maybeJsonlFallback` helper 必须 emit 用户首条 prompt 的 role='user' message**（让用户首条 prompt 入 events 不丢 — fresh fallback 路径下 finalizeSessionStart 被 Step 3a.5 guard 整段跳过 → session-finalize.ts:145-155 现行 emit role='user' 这一动作需由 helper 在 ctx.createSession 成功后补回）。emit payload 用 **opts.prompt（用户原 prompt）** 而非 prepend 后 summary prompt — UI 显示用户实际发的那条而非内部 augmented prompt
    - **`maybeJsonlFallback` helper 不 emit error message**（caller catch 块负责 — recoverer.ts:546-559「⚠ 自动恢复失败：...」+ restart-controller.ts:206-225 / 351-369「⚠ 切到 ${mode} / sandbox 失败：...」现行 emit + DB 回滚 + rethrow 模式）+ helper 内 createSession 抛错时 throw 让 caller catch 看到错误并按现行模式 emit + DB 回滚
    - fellBack=true 路径 helper 已包办（**R5 双方共识 emit 顺序修订** — 与 helper code snippet 实际「createSession 先 / emit 后」对齐）：①调 ctx.createSession with `resumeMode='fresh-cli-reuse-app'` ②emit fallback info message（按 §D4 三轴选 builder）③emit role='user' message（含 attachments 透传）④返 finalSessionId（caller 不再重复 emit / 不再重复 createSession）。**理由**：emit 必须在 createSession 成功后 — 否则 createSession 抛错时 emit fallback info 已发出，caller catch 块再 emit error message → 用户感知时间线错乱（先「fallback 已成功」后「失败」）
    - fellBack=false 路径 helper 仅做检查（不 emit 任何 message / 不 createSession），caller 自走原 resume 路径（restart-controller 走 line 182-198 / 331-346；recoverer 走 line 500-535）— 现有 createSession 主路径自带 finalizeSessionStart emit role='user' message 不需重复

## 设计决策

### D1 thunk 复用还是 RestartCtx 新增字段？

- 选项 A：RestartCtx interface 加 `jsonlExistsThunk: JsonlExistsThunk` 字段（与 RecovererCtx 同款）
- 选项 B：把 jsonlExistsThunk 上提到 RestartCtx + RecovererCtx 共享父类型 / 共享辅助 module

**决策（A）**：RestartCtx 加字段，与 RecovererCtx 镜像。

理由：选项 B 涉及重构 RecovererCtx + 引入新抽象层，scope 扩大；选项 A 最小入侵符合 user CLAUDE.md「不加额外抽象超出任务范围」。在 facade index.ts 创 RestartController + Recoverer 时双方 ctx 共享同一 thunk 实例（即 `(cwd, sid) => this.resumeJsonlExists(cwd, sid)` —— index.ts:126 已存在的 thunk）。

### D2 fallback 路径实现：抽 helper 共享 vs inline 简化版？

- 选项 A：直接调 `recoverer.recoverAndSend` 兜底（用户重发场景同款）
- 选项 B：在 restart-controller 内 inline 简化 fallback 路径（jsonl 预检 + ctx.createSession resumeMode='fresh-cli-reuse-app' + 简短 emit message）
- 选项 C：抽 helper `createSessionWithJsonlFallback(opts, ctx)` shared between recoverer + restart-controller（共享 prependHistorySummary + emitFallbackMessage）

**决策（C）**：抽 helper 共享 fallback 路径。

**Round 1 plan-review reviewer-codex HIGH-1 修法触发的升级**（原决策 B 升级）：实测 `src/main/ipc/adapters.ts:332` + `src/renderer/components/SessionDetail/ComposerSdk.tsx:218 / 255` 三处冷重启入口都传**裸 prompt** `'继续之前的会话'`（4 个字）。jsonl 缺失时 SDK 起 fresh CLI thread 拿到这 4 个字 → Claude 完全失上下文（不知道之前在做什么 plan / 切了一半的 plan 内容全丢）。原决策 B 「inline 简化版不引入 prependHistorySummary」直接遗留这个用户体验 bug（修了 hard fail 但没修上下文丢失）。

理由：
- (A) 语义错位 — recoverAndSend 是「sendMessage 断连自愈」，restart 是「冷切权限模式 / sandbox」（用户主动操作）；不能直接调
- (B) 缺历史摘要前情，jsonl 缺失场景下用户体验 bug — 不可接受（reviewer-codex HIGH-1 实测 3 处裸 prompt 铁证）
- **(C)** 抽 helper：让 recoverer + restart-controller 共享 jsonl-missing fallback 路径（含 prependHistorySummary + emitFallbackMessage 4 文案 + createThunk fresh-cli-reuse-app + return applicationSid）。jsonl 缺失场景两条路径都自动续上历史摘要，用户体感平滑。代价：实施量从原估 30 行升到约 80-120 行（recoverer.ts:378-491 抽离到 helper + restart-controller 两条路径调用 helper + helper 测试）+ recoverer.ts:378-491 重构（与 outer cwdFellBack 路径深度交织需慎重）

**Helper 接口设计**（详 §步骤 checklist Step 3a-h 实施细节，**Round 2 reviewer-codex MED-1 修法**：字段名与现有 RestartCtx / SummariseFnThunk 现状对齐避免 typecheck 错；**Round 3 reviewer-codex LOW-1 修法**：import 路径分散到正确 module；**Round 4 reviewer-codex LOW-1 修法**：UploadedAttachmentRef 实际在 `@shared/types`；**Round 5 reviewer-codex MED-1 修法**：补 AGENT_ID + PermissionMode import + sandbox 类型名 + readonly array 适配 + 抽 helper-local `JsonlFallbackCreateOpts` 让 RestartCtx/RecovererCtx createSession thunk 适配；**Round 6 reviewer-claude HIGH-1 + reviewer-codex MED-1 双方共识修法**：删 unused ClaudeCreateOpts import + attachments 改 mutable `UploadedAttachmentRef[]`（避免 strictFunctionTypes contravariance 拒 — claude tsc strict 实证铁证）；**Round 6 reviewer-codex LOW-1 修法**：sandbox 注释错正（实际 sandbox-resolve.ts:20 有 export type ClaudeSandboxMode）:
```ts
// src/main/adapters/claude-code/sdk-bridge/jsonl-fallback.ts (新建)
// **R3 codex LOW-1 + R4 codex LOW-1 + R5 codex MED-1 + R6 codex MED-1 修法**：import 路径分散 + 补漏 import + 删 unused
import { AGENT_ID } from './constants';                            // R5 codex MED-1: AGENT_ID 在 constants.ts:8 export，runtime import
import type { PermissionMode } from '@main/adapters/types';        // R5 codex MED-1: PermissionMode 在 main 层 adapter types:302（不在 sdk-bridge/types.ts）;**R6 codex MED-1 修法**: 删 unused `ClaudeCreateOpts` import — helper 内 ctx.createSession 已改 JsonlFallbackCreateOpts subset 类型不直接用 ClaudeCreateOpts，strict noUnusedLocals 会报错
import type { SdkSessionHandle } from './types';                   // SdkSessionHandle 在 sdk-bridge/types
import type { JsonlExistsThunk, SummariseFnThunk } from './recoverer';  // 两个 thunk 在 recoverer.ts:138 / :160 export（type-only import 不构成 runtime 循环 — claude R4 F2 已实测验证）
import type { AgentEvent, UploadedAttachmentRef } from '@shared/types';  // R4 codex LOW-1 修法：UploadedAttachmentRef 在 @shared/types barrel（src/shared/types/attachment.ts:31 export）
import {
  buildJsonlMissingSummaryUsedText,
  buildJsonlMissingSummarySkippedText,
  buildCwdFallbackSummaryUsedText,
  buildCwdFallbackSummarySkippedText,
  buildRestartJsonlMissingSummaryUsedText,    // Step 3a.6 新建 builder
  buildRestartJsonlMissingSummarySkippedText, // Step 3a.6 新建 builder
} from './recoverer-messages';                // runtime import — 6 文案 builder 实施位置（recoverer-messages.ts 是 leaf 模块，不反向 import jsonl-fallback.ts，0 循环）

// **R5 codex MED-1 修法**：抽 helper-local create opts 类型，作为 ClaudeCreateOpts / RestartCreateOpts 的最小公共 subset，让 RestartCtx/RecovererCtx 的 createSession thunk 适配统一接口避免「ClaudeCreateOpts 完整字段 vs RestartCreateOpts 子集」类型 mismatch
export interface JsonlFallbackCreateOpts {
  cwd: string;
  prompt: string;                                    // 必填（与 RestartCreateOpts 同款）
  resume: string;                                    // applicationSid 复用（fresh-cli-reuse-app 路径必填）
  resumeMode: 'fresh-cli-reuse-app';                 // 字面量约束 — 仅 fresh fallback 路径用此 helper
  permissionMode?: PermissionMode;
  claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict';  // R5 codex MED-1 / **R6 codex LOW-1 修订**: 真问题是 `SandboxKind` 不存在（不是 `ClaudeSandboxMode`）— 实际 sandbox-resolve.ts:20 有 export type ClaudeSandboxMode = 'off' | 'workspace-write' | 'strict'。本 helper 为减少跨模块 import 直接用字面量类型（与 RestartCreateOpts:35 / ClaudeCreateOpts 同款）；如未来想 SSOT 化可改 `import type { ClaudeSandboxMode } from './sandbox-resolve'`
  model?: string;
  extraAllowWrite?: readonly string[];
  attachments?: UploadedAttachmentRef[];             // **R6 claude HIGH-1 + codex MED-1 双方共识修法**：mutable `UploadedAttachmentRef[]` 与 CreateSessionThunk (recoverer.ts:62) / ClaudeCreateOpts (types.ts:53) 字面对齐 — 原 R5 写 `readonly` 撞 strictFunctionTypes contravariance（claude R6 tsc strict mini-runner 实证 Step 3f line 320 `createSession: this.createThunk` 直传必撞 TS2322 error），改 mutable 让 Step 3f 直传可 typecheck；语义上 helper 内 `[...arr]` spread 转 readonly→mutable 时自然降级无副作用
}

export interface JsonlFallbackCtx {
  jsonlExistsThunk: JsonlExistsThunk;
  // **R5 codex MED-1 修法**：thunk 收 helper-local create opts 而非完整 ClaudeCreateOpts，让 RestartCtx/RecovererCtx 的 createSession 适配该最小 subset 避免类型不匹配
  createSession: (opts: JsonlFallbackCreateOpts) => Promise<SdkSessionHandle>;
  emit: (event: AgentEvent) => void;
  summariseFn: SummariseFnThunk;
  listEventsFn: (sid: string) => readonly AgentEvent[];
}

// **R5 codex MED-2 + R5 claude HIGH-1 修法**：discriminated union — emitContext='restart' 时 restartLabel 必填字段，emitContext='recover' 时 restartLabel 不允许字段（`?: never`）。让 TS 编译期阻拦 Step 3d/3e snippet 漏传 restartLabel + 消除 helper code snippet `opts.restartLabel!` non-null assertion 隐藏的 runtime 错乱
type JsonlFallbackOptsBase = {
  sessionId: string;
  cliSessionId: string | null;
  cwd: string;
  prependCwd: string;
  prompt: string;
  permissionMode?: PermissionMode;
  claudeCodeSandbox?: 'off' | 'workspace-write' | 'strict';
  model?: string;
  extraAllowWrite?: readonly string[];
  attachments?: UploadedAttachmentRef[];  // **R6 claude HIGH-1 + codex MED-1 修法**：mutable 与 JsonlFallbackCreateOpts.attachments + CreateSessionThunk 对齐避免 typecheck 失败
};

export type JsonlFallbackOpts =
  | (JsonlFallbackOptsBase & {
      emitContext: 'recover';
      cwdFellBack?: boolean;       // recover 路径独有
      restartLabel?: never;        // 编译期阻拦
    })
  | (JsonlFallbackOptsBase & {
      emitContext: 'restart';
      cwdFellBack?: false;          // restart 路径不切 cwd，cwdFellBack 永远 false（discriminated 但保留字段对实施 snippet 一致）
      restartLabel: string;         // 必填 — 「权限模式 ${mode}」 / 「OS 沙盒 ${sandbox}」
    });

export interface JsonlFallbackResult {
  finalSessionId: string;
  fellBack: boolean;
}

export async function maybeJsonlFallback(
  ctx: JsonlFallbackCtx,
  opts: JsonlFallbackOpts,
): Promise<JsonlFallbackResult>;
```

helper 内部行为（**R5 codex LOW-1 + claude MED-1 双方共识修订** — emit 顺序与 §不变量 11 项 4 + helper code snippet 标题对齐：createSession 先 / emit 后）：
1. jsonl 预检：`ctx.jsonlExistsThunk(opts.cwd, opts.cliSessionId ?? opts.sessionId)` → false 或 `cwdFellBack`=true 时进 fallback 分支（OR 短路求值）
2. fallback 分支：调 `prependHistorySummary({ ... })` 拿 prompt + summaryResult.used flag → 调 `ctx.createSession` 走 `resumeMode='fresh-cli-reuse-app'` 路径 → **emit fallback info message**（按 §D4 三轴选 builder）→ **emit role='user' message**（含 attachments 透传）→ 返 `{ finalSessionId: opts.sessionId, fellBack: true }`
3. 正常分支：jsonl 存在 + 非 cwdFellBack → 直接返 `{ finalSessionId: opts.sessionId, fellBack: false }`，caller 自己走原 resume 路径（不通过 helper）

**helper 内部 createSession opts 拼装规则**（**R2 claude MED-F2-1 修法**：显式列 spread 字段避免实施者推断歧义）：
```ts
// helper 内部 fallback 分支 createSession 调用：
await ctx.createSession({
  cwd: opts.cwd,
  prompt: summaryResult.prompt,        // prependHistorySummary 返回（可能含/不含摘要）— 给 SDK CLI 当 cold-start prompt
  resume: opts.sessionId,              // applicationSid 复用（不变量 2）
  resumeMode: 'fresh-cli-reuse-app',   // 不变量 2 — 触发 createSession 内 finalize guard 跳过 finalizeSessionStart（不变量 9）
  permissionMode: opts.permissionMode,
  claudeCodeSandbox: opts.claudeCodeSandbox,
  model: opts.model,
  extraAllowWrite: opts.extraAllowWrite,
  attachments: opts.attachments,
  // ⚠️ **严禁**传 resumeCliSid 字段（不变量 10 + types.ts:121-133 7 种合法/非法组合表 runtime guard reject）
});
```

**helper 调 createSession 成功后必做 1: emit fallback info message**（**R4 codex HIGH-1 修法 — 不变量 11**）:
```ts
// 按 emitContext × cwdFellBack × summaryResult.used 三轴选 builder（详 §D4 文案矩阵 6 case）
// recoverer 路径 cwdFellBack 可 true / restart 路径 cwdFellBack 永远 false → matrix 共 6 case
let fallbackMessage: string;
if (opts.emitContext === 'recover') {
  if (opts.cwdFellBack) {
    fallbackMessage = summaryResult.used
      ? buildCwdFallbackSummaryUsedText()
      : buildCwdFallbackSummarySkippedText();
  } else {
    fallbackMessage = summaryResult.used
      ? buildJsonlMissingSummaryUsedText(opts.cwd)
      : buildJsonlMissingSummarySkippedText(opts.cwd);
  }
} else { // emitContext === 'restart' — discriminated union 让 TS 已 narrow opts.restartLabel: string（必填）
  fallbackMessage = summaryResult.used
    ? buildRestartJsonlMissingSummaryUsedText(opts.restartLabel, opts.cwd)
    : buildRestartJsonlMissingSummarySkippedText(opts.restartLabel, opts.cwd);
  // R5 codex MED-2 + claude HIGH-1 修法：opts.restartLabel 由 discriminated union narrow 为 string 必填，不再用 `opts.restartLabel!` non-null assertion
}
ctx.emit({
  sessionId: opts.sessionId,
  agentId: AGENT_ID,
  kind: 'message',
  payload: { text: fallbackMessage },  // 非 error fallback info（区分 caller catch 块的 error message）
  ts: Date.now(),
  source: 'sdk',
});
```

**helper 调 createSession 成功后必做 2: emit role='user' message**（**R3 codex HIGH-1 修法 — 不变量 11**）:
```ts
// 让用户首条 prompt 入 events 不丢
// （fresh fallback 路径 createSession 内 Step 3a.5 finalize guard 跳过整个 finalizeSessionStart →
// session-finalize.ts:145-155 现行 emit role='user' 这一动作必须由 helper 在此处补回；
// 字段对齐 index.ts:477-488 sendMessage live session 分支 emit 含 attachments 透传 5 字段 payload）
ctx.emit({
  sessionId: opts.sessionId,
  agentId: AGENT_ID,
  kind: 'message',
  payload: {
    text: opts.prompt,                                                          // 用户原 prompt（不是 prepend 后 summary prompt）
    role: 'user',
    ...(opts.attachments && opts.attachments.length > 0 ? { attachments: opts.attachments } : {}),
  },
  ts: Date.now(),
  source: 'sdk',
});
```

**Caller 集成**:
- recoverer.ts:378-491 改为：先调 maybeJsonlFallback（emitContext='recover'，restartLabel 不传符合 discriminated union 'recover' 分支约束）；fellBack=true 直接 return finalSessionId；fellBack=false 走原 resume 路径（line 500-535 不变）。catch 块 line 546-559「⚠ 自动恢复失败」emit error message 不变（helper throw 时 caller catch 看到错误）
- restart-controller.ts:182 / 331：先调 maybeJsonlFallback（emitContext='restart' + **必传 restartLabel** — Step 3d 传 `\`权限模式 ${mode}\`` / Step 3e 传 `\`OS 沙盒 ${sandbox}\``，**discriminated union 编译期阻拦漏传** — R5 codex MED-2 + claude HIGH-1 修法）；fellBack=true 直接 return currentSid；fellBack=false 走原 resume 路径（line 182-198 / 331-346 不变）。catch 块 line 206-225 / 351-369「⚠ 切到 ${mode} / sandbox 失败」emit error + DB 回滚不变

### D3 jsonl 预检的 sessionId 用哪个？

- 选项 A：currentSid（== applicationSid，反向 rename 后稳定）
- 选项 B：rec.cliSessionId ?? currentSid（与现有 resumeCliSid 计算一致，cli sid 维度找 jsonl）

**决策（B）**：用 rec.cliSessionId ?? currentSid。

理由：CLI jsonl 文件路径用 cli sid 命名（即 `~/.claude/projects/<encoded-cwd>/<cliSessionId>.jsonl` — types.ts:97 + spike1 §1.2 实证）；反向 rename 后 cliSessionId 是 SDK 当前 thread sid（与 jsonl 文件名对应），currentSid（applicationSid）与 jsonl 文件名解耦。预检需找 jsonl 必须用 cli sid。这与 line 189 / 336 的 `resumeCliSid: rec.cliSessionId ?? currentSid` 一致（同款回退链）。

**反向 rename 后语义补充**（plan-review Round 1 reviewer-claude MED-F3-1 修法）：

- `currentSid` 在反向 rename 后仍是 sessions.id（applicationSid）维度（restart-controller.ts:117-128 fork rename listener 把 currentSid 切到 payload.to == NEW applicationSid，仍是 sessions.id 维度）
- `rec.cliSessionId` 是 sessions.cli_session_id 列值（与 jsonl 文件名对应，rename 后跟 SDK 当前 thread sid 走）
- `?? currentSid` 兜底防 cli_session_id null 边角（types.ts:99-102: spawn tempKey 阶段 / fresh-cli-reuse-app 期间 cliSessionId 暂时 null）
- restart 路径 caller 已是老会话，cli_session_id 一定写入完成 → 实际不会走此兜底（保留兜底为防御性 fail-safe，与 line 189 / 336 同款）

### D4 emit fallback message 文案

**Round 2 reviewer-claude HIGH-F1-1 修法**：原 D4 单一文案与 D2-C helper 内 prependHistorySummary 双态分文案矛盾。新版按 `emitContext × cwdFellBack × summary used/failed` 三轴选文案（与 recoverer-messages.ts 现 4 文案模板对齐 + restart 路径加 4 文案）：

restart 路径已 emit placeholder message（line 152-163 / 311-318）「⚠ 正在切换权限模式 / OS 沙盒档位...」。fallback 分支额外 emit 一条信息（非 error）按以下三轴矩阵：

| emitContext | cwdFellBack | summary used | 文案模板（recoverer-messages.ts） |
|---|---|---|---|
| 'recover' | false | true | `buildJsonlMissingSummaryUsedText(cwd)` — jsonl 缺失 + 续上摘要 |
| 'recover' | false | false | `buildJsonlMissingSummarySkippedText(cwd)` — jsonl 缺失 + 摘要不可用 |
| 'recover' | true | true | `buildCwdFallbackSummaryUsedText()` — cwd 切换 + 续上摘要 |
| 'recover' | true | false | `buildCwdFallbackSummarySkippedText()` — cwd 切换 + 摘要不可用 |
| 'restart' | false | true | **新建** `buildRestartJsonlMissingSummaryUsedText(mode \| sandbox, cwd)` — jsonl 缺失 + 续上摘要 + 已切档 |
| 'restart' | false | false | **新建** `buildRestartJsonlMissingSummarySkippedText(mode \| sandbox, cwd)` — jsonl 缺失 + 摘要不可用 + 已切档 |
| 'restart' | true | * | N/A — restart 路径 cwdFellBack 永远 false（restart 不切 cwd） |

restart 路径新建 2 文案样例：

- `buildRestartJsonlMissingSummaryUsedText`: `⚠ jsonl 不存在 (cwd=${cwd})，已通过 LLM 摘要前情续上历史，已起 fresh CLI thread + 切换到 ${modeOrSandboxLabel}`
- `buildRestartJsonlMissingSummarySkippedText`: `⚠ jsonl 不存在 (cwd=${cwd})，CLI 历史已丢且摘要不可用，请重新发送消息让 Claude 续上 (已切到 ${modeOrSandboxLabel})`

`modeOrSandboxLabel` = restartWithPermissionMode 路径 = `权限模式 ${mode}` / restartWithClaudeCodeSandbox 路径 = `OS 沙盒 ${sandbox}`。

**实施位置**：在 `src/main/adapters/claude-code/sdk-bridge/recoverer-messages.ts` 加 2 个新 builder（与现 4 个 jsonl 缺失 / cwdFallback 文案 builder 同模块）；helper 内部按三轴选 builder。文案设计原则：summary used → 强调「续上前情」消除用户「历史丢」体感；summary skipped → 仍说「请补背景」与现 recoverer 体验一致。

### D5 测试矩阵 (写到 .test.ts)

- T1: jsonl 在 → fbResult.fellBack=false，走 line 182-198 / 331-346 现有 resume 路径（不退化；**断言** createSession opts 含 `resumeCliSid: rec.cliSessionId ?? currentSid`，符合不变量 8）
- T2: jsonl 缺失（jsonlExistsThunk 返 false）→ fbResult.fellBack=true，走 helper fallback 路径（**断言** helper 内部 createSession opts: `resume === currentSid` + `resumeMode === 'fresh-cli-reuse-app'` + **不含 resumeCliSid 字段**——符合不变量 10；**断言** finalizeSessionStart spy.callCount === 0 — 符合不变量 9 + Step 3a.5 finalize guard）+ DB 改 mode/sandbox 持久化（caller 已写 DB）
- T3: jsonl 缺失 + helper fallback createSession 抛错 → DB 回滚 oldMode/oldSandbox + emit error message + throw（**断言** catch 块 rollback 走通；fallback 走原 catch line 206-225 / 351-374）
- T4: cliSessionId 与 applicationSid 不同（反向 rename 场景）→ helper 用 cliSessionId 找 jsonl（D3 决策；**mock setup**: `sessionRepo.get` 返 `{ ..., cliSessionId: 'cli-sid-X' }`，currentSid 是 'app-sid-Y'，不要求实际触发 fork rename，只测 D3 cli sid 维度取值逻辑）
- T5: jsonlExistsThunk 抛异常 → fail-safe 退化原行为（jsonl 在 + 走正常 resume；与 defaultResumeJsonlExists fail-safe 一致）
- T6: handoffPrompt 空字符串 / 全空白 → 不论 jsonl 在/不在都 throw（line 89-91 / 260-264 校验先于 jsonl 预检；T6 行为不变于本次改动）
- T7: helper 单测 — fellBack=true 路径覆盖 prependHistorySummary 成功（**断言** emit 走 `buildRestartJsonlMissingSummaryUsedText` / `buildJsonlMissingSummaryUsedText` 文案；emitContext='restart' / 'recover'）/ 失败（断言 emit 走 `*SummarySkippedText` 文案）双态
- T8: helper 单测 — emitContext='recover' × cwdFellBack 双 flag 笛卡尔 4 文案分支 + emitContext='restart' × cwdFellBack=false 走 2 个新文案分支（jsonl missing summary used / skipped），共 6 文案 case 覆盖 §D4 文案矩阵
- T9: **R2 reviewer-codex HIGH-1 + R3 reviewer-codex HIGH-1 + R4 reviewer-codex HIGH-1 + INFO-1 修法测试** — `createSession({ resume, resumeMode:'fresh-cli-reuse-app' })` 拿到 first realId 后:
  - **断言** `finalizeSessionStart spy.callCount === 0`（不 emit `session-start` 不 setClaudeCodeSandbox 不 setModel 不 setExtraAllowWrite — Step 3a.5 finalize guard 完整生效）
  - **断言** `sessionManager.updateCliSessionId(applicationSid, realId)` spy.callCount === 1（fresh fallback 仅靠 stream-processor 内部链写 cli_session_id 列）
  - **断言** `emit role='user' message` spy.callCount === 1（**R3 codex HIGH-1 修法** — helper 在 createSession 成功后补 emit user message，让用户首条 prompt 入 events 不丢）
  - **断言** emit payload.text === opts.prompt（用户原 prompt 不是 prepend 后 summary prompt）+ payload.role === 'user'
  - **R4 codex HIGH-1 修法 + INFO-1 修法 + claude R4 LOW-1 修法 — T9a/T9b 拆 sub-case 显式覆盖 attachments 双场景**：
    - **T9a** `opts.attachments = undefined` → 断言 `payload` 对象 **不含** `attachments` 字段 (`expect(payload).not.toHaveProperty('attachments')`)
    - **T9b** `opts.attachments = []`（空数组）→ 断言 `payload` 对象 **不含** `attachments` 字段（与 helper code snippet 条件 spread `length > 0` 对齐）
    - **T9c** `opts.attachments = [ref1, ref2]` → 断言 `payload.attachments === opts.attachments`（reference 透传）
  - **R4 codex HIGH-1 修法 — fallback info message emit 断言**：断言 emit `kind='message'` `payload.text` 走 §D4 6 文案矩阵对应 builder（`emit spy.callCount === 2` — 1 次 fallback info + 1 次 role='user'，按 emit 顺序断言 first call 走 builder text / second call 走 opts.prompt）
- T10: **LOW-F4-1 OR 短路 sub-case** — T10a (短路验证): cwdFellBack=true + jsonlExistsThunk spy → expect spy.callCount === 0（cwdFellBack=true 时短路不调 jsonlExistsThunk，让 fail-safe 不被绕过）；T10b (短路逆向): cwdFellBack=false + jsonlExistsThunk spy → expect spy.callCount === 1

预计 10 个新 test case 在现有 `restart-controller.test.ts`（T1-T6 + T9）+ 新建 `jsonl-fallback.test.ts`（T7-T8 + T10 helper 单测）。

## 步骤 checklist

- [ ] **Step 1.5 deep-review** invoke `/agent-deck:deep-review` SKILL kind='plan' paths=['<plan-abs-path>']，多轮异构对抗 + 反驳轮 + 三态裁决；finding HIGH 必修；0 HIGH 0 真 MED 才进 Step 2
- [ ] **Step 2 EnterWorktree** user confirm 看完 plan + Step 1.5 finding 后才进 worktree。按 user CLAUDE.md §EnterWorktree CLI stale base bug callout 主路径 (b)：`git -C <main-repo-abs-path> worktree add -b worktree-restart-controller-jsonl-precheck-20260521 <main-repo-abs-path>/.claude/worktrees/restart-controller-jsonl-precheck-20260521` + `EnterWorktree(path: <abs-worktree-path>)` 两步形式；进 worktree 后立即 `Bash: pwd` 自检
- [ ] **Step 3a** 新建 `src/main/adapters/claude-code/sdk-bridge/jsonl-fallback.ts` helper module（含 `maybeJsonlFallback(ctx, opts): Promise<JsonlFallbackResult>` 函数 + 三个 interface `JsonlFallbackCtx / JsonlFallbackOpts / JsonlFallbackResult`，详 §设计决策 D2 末段 helper 接口设计）。helper 内部 inline 现 recoverer.ts:378-491 的 fallback 逻辑（jsonl 预检 + prependHistorySummary + createSession resumeMode='fresh-cli-reuse-app' + **emit fallback info message** 按 §D4 三轴矩阵 6 文案 helper 内部自己 emit（**R4 codex HIGH-1 修法**：原 R3 修法写「caller catch emit」是设计错，caller catch 只看异常看不到成功 fallback path）+ **emit role='user' message** 让用户首条 prompt 入 events 不丢（不变量 11 修法）+ return applicationSid）
- [ ] **Step 3a.5** **R2 reviewer-codex HIGH-1 修法**：改 `src/main/adapters/claude-code/sdk-bridge/index.ts:419-428` createSession finalize 链加 `if (opts.resumeMode !== 'fresh-cli-reuse-app') { finalizeSessionStart(...) }` guard。fresh fallback 路径完全跳过 finalizeSessionStart（不 emit session-start + 不 setClaudeCodeSandbox + 不 setModel + 不 setExtraAllowWrite + 不补 emit 首条 user message）— 完整实施 R6 MED-R6-1 修订让 jsdoc（session-finalize.ts:31/41/74）与 runtime 一致；fresh fallback 仅依赖 stream-processor.ts:336-342 内部 `sessionManager.updateCliSessionId` 单点 UPDATE cli_session_id 列（不变量 9）。**注**：finalize 链跳过的 emit role='user' message 由 helper 在 ctx.createSession 成功后补回（不变量 11 + §D2 helper 接口末段）— **R3 reviewer-codex HIGH-1 修法** 避免用户首条 prompt 从 events / UI 失踪 regression
- [ ] **Step 3a.6** **R2 reviewer-claude HIGH-F1-1 修法**：在 `src/main/adapters/claude-code/sdk-bridge/recoverer-messages.ts` 加 2 个新 builder：`buildRestartJsonlMissingSummaryUsedText(label, cwd)` + `buildRestartJsonlMissingSummarySkippedText(label, cwd)`（详 §D4 文案矩阵 'restart' 行）。helper 内部按 emitContext='restart' 选这 2 个 builder
- [ ] **Step 3b** 改 `RestartCreateOpts`（restart-controller.ts:22-44）加 `resumeMode?: 'resume-cli' | 'fresh-cli-reuse-app'` 字段（与 ClaudeCreateOpts 字段对齐让 ctx.createSession 透传 fallback 路径不丢精度）
- [ ] **Step 3c** 改 `RestartCtx` interface（restart-controller.ts:46-58）加 helper 需要的 ctx 字段：`jsonlExistsThunk: JsonlExistsThunk` + `summariseFn: SummariseFnThunk` + `listEventsFn: (sid) => readonly AgentEvent[]`（emit / createSession 已有）。从 recoverer.ts 同款 import 类型，所有 thunk 与 RecovererCtx 共享同实例（index.ts 注入 — Step 3g）
- [ ] **Step 3d** 改 `restartWithPermissionMode`（restart-controller.ts:84-238）在 line 182 createSession 调用前调 helper：
  ```ts
  const fbResult = await maybeJsonlFallback(this.ctx, {
    sessionId: currentSid,
    cliSessionId: rec.cliSessionId,
    cwd: rec.cwd,
    prependCwd: rec.cwd,         // restart 路径 cwdFellBack 永远 false → prependCwd === cwd
    prompt: handoffPrompt,
    permissionMode: mode,
    claudeCodeSandbox: rec.claudeCodeSandbox ?? undefined,
    extraAllowWrite: rec.extraAllowWrite ?? undefined,
    cwdFellBack: false,
    emitContext: 'restart',
    restartLabel: `权限模式 ${mode}`,  // R5 codex MED-2 + claude HIGH-1 修法：discriminated union 'restart' 分支必填字段，给 buildRestartJsonlMissingSummary[Used|Skipped]Text(label, cwd) 用作 label 参数；如不传 TS 编译期报错
  });
  if (fbResult.fellBack) return fbResult.finalSessionId; // == currentSid（不变量 11 helper 已包办 emit + createSession，caller 不再重复）
  ```
  jsonl 在时 fbResult.fellBack=false，继续走原 line 182-198 路径不变（fall through 到 line 182 ctx.createSession 调用）。**fallback opts 硬约束 omit resumeCliSid**（不变量 10 + R1 codex MED-1 修法 — helper 内部 createSession 调用不传 resumeCliSid 字段）
- [ ] **Step 3e** 改 `restartWithClaudeCodeSandbox`（restart-controller.ts:254-388）同款修改（line 331 附近，对称 Step 3d，emitContext 仍是 'restart'，prependCwd === cwd）。**额外**：R5 codex MED-2 + claude HIGH-1 修法 — restartLabel 改传 `\`OS 沙盒 ${sandbox}\``（与 Step 3d 模板对应，sandbox 路径专属 label；discriminated union 'restart' 分支必填，TS 编译期阻拦漏传）
- [ ] **Step 3f** 重构 `recoverer.ts:378-491` 调 maybeJsonlFallback：
  ```ts
  // recoverer.ts:378-491 重构后：
  const fbResult = await maybeJsonlFallback(
    {
      jsonlExistsThunk: this.jsonlExistsThunk,
      createSession: this.createThunk,  // RecovererCtx 字段名是 createThunk，helper 接口字段名是 createSession（命名对齐 RestartCtx）
      emit: this.ctx.emit,
      summariseFn: this.summariseFn,
      listEventsFn: this.listEventsFn,  // R2 claude HIGH-F3-1 修法：新增 ctor 字段 + facade 加 listEventsForSession protected method（详 Step 3g）
    },
    {
      sessionId,
      cliSessionId: rec.cliSessionId,
      cwd: effectiveCwd,
      prependCwd: cwdFellBack ? rec.cwd : effectiveCwd,  // R2 claude HIGH-F1-2 修法：cwdFellBack=true 时传 OLD cwd（与 recoverer.ts:392 现行为对齐）
      prompt: text,
      permissionMode: rec.permissionMode ?? undefined,
      claudeCodeSandbox: rec.claudeCodeSandbox ?? undefined,
      model: rec.model ?? undefined,
      extraAllowWrite: rec.extraAllowWrite ?? undefined,
      attachments,
      cwdFellBack,
      emitContext: 'recover',
    },
  );
  if (fbResult.fellBack) return fbResult.finalSessionId;
  // fall through 到原 line 500+ 正常 resume 路径（resumeCliSid: rec.cliSessionId ?? sessionId 等）不变
  ```
  Round 2 fix 验证不破现有 recoverer.test.ts；line 378-491 删除（含 prependHistorySummary 调用 + 4 文案 emit / createThunk fresh-cli-reuse-app / return statement 全部移到 helper 内）
- [ ] **Step 3g** **R2 reviewer-claude HIGH-F3-1 修法**：改 facade `index.ts:101-106` RestartController ctor + `index.ts:122-129` SessionRecoverer ctor **两侧**都加 helper 需要的字段：
  - RestartController ctor 新增 3 字段：`jsonlExistsThunk` + `summariseFn` + `listEventsFn`
  - SessionRecoverer ctor 新增 1 字段：`listEventsFn`（已有 createThunk / sendThunk / jsonlExistsThunk / cwdExistsThunk / summariseFn 5 字段）
  - facade 新增 protected method `listEventsForSession(sid: string): readonly AgentEvent[]`（默认实现 = `eventRepo.listForSession(sid)`，与现有 `resumeJsonlExists / cwdExists / summariseForHandOff` 同款 protected wrapper 模式 — TestBridge 通过 extend facade override 该方法 mock event 序列）
  - 两侧 ctor 注入 listEventsFn 用同款 closure：`(sid) => this.listEventsForSession(sid)`
  - 配套：把 recoverer.ts:395 inline `listEventsFn: (sid) => eventRepo.listForSession(sid)` 改为从 ctor 注入字段拿（reuse helper）
- [ ] **Step 4 测试** 加 10 个 test case 覆盖 T1-T10（D5 测试矩阵更新版）+ helper 单测（T7 + T8 + T9）；用 TestBridge extend facade override resumeJsonlExists / summariseFn / listEventsFn 模式（与 recoverer 测试同款）
- [ ] **Step 5 verify** typecheck + 跑 sdk-bridge 相关测试（`pnpm exec vitest run src/main/adapters/claude-code/sdk-bridge/__tests__/`）+ 跑 recoverer.test.ts（确保重构不退化）+ 跑 manager-ingest 相关测试（确保 Step 3a.5 finalize guard 改动不破 ingest 链路）+ commit
- [ ] **Step 6 archive_plan** ExitWorktree(action:keep) → archive_plan(plan_id, worktree_path, changelog_id)。changelog 引用归档（不抄全 plan）。

## 当前进度

- ✅ Step 0/0.5/1 完成（design 决策清楚不需 RFC / spike，plan 文件已写）
- ⏳ Step 1.5 deep-review 待 invoke
- ⏳ Step 2 EnterWorktree 待 user confirm

## 下一会话第一步

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/restart-controller-jsonl-precheck-20260521.md` 全文
2. 跳到 §步骤 checklist 找 unchecked 项继续
3. **未进 worktree**：从 §Step 1.5 deep-review 开始
4. **已进 worktree**：从 frontmatter `worktree_path` 读出路径 → `EnterWorktree(path: <wt-path>)` 进 worktree → Step 3a-Step 5 推进

## 已知踩坑

1. **resumeCliSid 在 fallback 路径**：fallback 路径用 resumeMode='fresh-cli-reuse-app'，bridge 内部 line 309 `effectiveResumeCliSid = ... resumeMode === 'fresh-cli-reuse-app' ? undefined` — caller（restart-controller / recoverer）**禁止显式传 resumeCliSid**（types.ts:121-133 7 种合法/非法组合表把 fresh + 非空 resumeCliSid 列为 **runtime guard reject** 非法组合 — 不变量 10）。helper 内部 createThunk 调用必须 omit 字段（不写在 opts 对象内）让代码意图清晰
2. **inflight wait 期间 fork rename listener** (restart-controller.ts:117-130 / 279-289)：fallback 路径仍位于 listener 作用域内，listener 监听 session-renamed event 处理 fork rename。fallback 走 fresh-cli-reuse-app 不会触发 fork rename（session.id 不变），但仍要保证 listener 不 leak（finally line 234-237 / 387-390 已 off）
3. **DB 回滚路径** (line 206-225 / 351-374)：fallback 失败时也走同款 catch 块，回滚 oldMode/oldSandbox + emit error message + throw — 不需要单独写新 catch，复用现有 catch
4. **single-flight `recovering` Map**：fallback 路径仍位于 `recovering.set(currentSid, p)` 单飞标记内 (line 228-233 / 380-385)，不会跟另一并发 restart 撞
5. **EnterWorktree CLI stale base bug**：必走主路径 (b) Bash 显式建 worktree + EnterWorktree(path:...) 两步形式，避开 v2.1.112 stale base bug（base = origin/main 而非本地 HEAD）
6. **测试 mock**：`TestBridge` extend facade override `resumeJsonlExists` / `summariseFn` / `listEventsFn`（**R2 reviewer-claude MED-F3-4 配套修法** — Step 3g 新增 facade `listEventsForSession` protected method 让 TestBridge override；与现有 `resumeJsonlExists / cwdExists / summariseForHandOff` protected wrapper 模式同款）。同时影响 RestartController 和 Recoverer（共享同一 ctx 字段实例），mock 写法需对应 helper 接口（详 §D5 T4 mock setup）
7. **裸 prompt 在 jsonl 缺失场景**（plan-review Round 1 reviewer-codex HIGH-1 修法）：实测 `ipc/adapters.ts:332` + `ComposerSdk.tsx:218 / 255` 三处冷重启入口都传裸 `'继续之前的会话'`（4 个字）。jsonl 缺失场景下若不引入 prependHistorySummary，SDK 起 fresh CLI thread 拿到这 4 个字 → Claude 完全失上下文。本 plan **D2 决策升级到 (C) helper** 让 restart-controller 与 recoverer 共享 fallback 路径，自动续上历史摘要前情；裸 prompt 通过 helper.prependHistorySummary 自动包装为 "前情摘要 + 用户原 prompt"
8. **fallback 路径不调 finalizeSessionStart 是 createSession 内部 resumeMode 分支识别**（plan-review Round 1 reviewer-claude LOW-F5-2 修法）：helper 内部走 createThunk 时 opts.resumeMode='fresh-cli-reuse-app' → bridge 内部识别此 mode → 跳过 finalizeSessionStart 创建新 sessions row + 跳过 emit session-start（避免撞唯一索引），仅走 sessionManager.updateCliSessionId 单点 UPDATE cli_session_id 列。这是 createSession 路径自带的契约（session-finalize.ts:31/41/74 jsdoc + recoverer.ts:455-490 实施样本），helper 不需额外做 finalize 跳过逻辑
9. **D2-C helper 抽离重构 recoverer.ts:378-491 with care**：outer cwdFellBack 路径与 inner jsonl-missing fallback 路径深度交织（recoverer.ts:418-437 cwdFellBack=true 路径独立 emit 4 文案 + 仍调 prependHistorySummary）。helper 设计需把 cwdFellBack 当 opts.cwdFellBack 字段透传，让 helper 内部分两路 emit（emitContext='recover' 时根据 cwdFellBack flag 走 4 文案 / emitContext='restart' 时 cwdFellBack 永远 false 用单一 'restart' 文案）。Round 2 reviewer 重点验证 cwdFellBack 路径行为不退化
