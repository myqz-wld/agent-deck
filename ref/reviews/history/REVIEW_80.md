# REVIEW_80 — 全项目 deep review 批 D2：codex-cli sdk-bridge thread-loop + translate + finalize + restart

- 日期: 2026-05-31
- 类型: Debug / 功能 BUG + 代码优化 + 文字措辞（全项目 deep review 第十批，Batch D 子批 D2）
- 触发: 用户「deep review 下项目，自主一路推进 + 自主 hand off」授权（plan deep-review-project-20260531）
- 关联: plan deep-review-project-20260531 / REVIEW_79（D1）/ REVIEW_69-70（codex translate/win32 基线）
- 方法: 多轮异构对抗（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5，复用 D pair dr-project-d-20260531）+ 三态裁决 + lead 全链 trace（restart 冷切序列 closeSession→setCodexSandbox→createSession + try 边界 / IPC 契约 ipc/adapters.ts:395 / claude restart-controller parity）+ **temp-revert 复现验证**。
- 收口: R1 双 reviewer reply。**MED 双方独立共识**（codex + claude 各自指出 restart-controller setCodexSandbox throw 窗口，claude 补 2 细节：回滚自身掩盖 err + claude 对称）；**LOW 双方独立同向**（codex + claude 都说 loader-warning filter `'failed to deserialize'` 单独命中过宽 → AND 锚点）。0 HIGH。lead 现场验证 MED 事实链（core-crud.ts:203 无 try/catch + ipc 契约 + claude parity）+ temp-revert 双 test 确定性复现 → ✅ 修。typecheck 双配置 + codex-cli 135 passed（+4 回归 test，2 MED temp-revert 各验证非空）。

## 范围（批 D2）

codex-cli SDK adapter bridge 的「thread 启动 + turn loop + 事件翻译 + 字段持久化 + 冷重启 + resume 等待」子模块，5 文件 ~1390 LOC：

| 文件 | LOC | 职责 |
|---|---|---|
| `sdk-bridge/thread-loop.ts` | 374 | startNewThreadAndAwaitId（新建 thread + 30s fallback + earlyErr）+ runTurnLoop（串行消费 pendingMessages + thread.started case 1/2/3 fork-detect 核心） |
| `translate.ts` | 422 | codex ThreadEvent → AgentEvent 翻译（error 三态分类 transient/fatal/heuristic + item translation + loader-warning filter） |
| `sdk-bridge/session-finalize.ts` | 112 | persistSessionFields（setCodexSandbox + setModel + extraAllowWrite） |
| `sdk-bridge/restart-controller.ts` | 178 | restartWithCodexSandbox 冷切档（单飞 + close + DB write + createSession resume + 回滚） |
| `sdk-bridge/resume-path-await.ts` | 194 | resume 路径 thread.started 三态状态机（onFirstId / earlyErrCb 4 资源 cleanup / 30s timeout） |

## 三态裁决结果

### [MED ✅ reviewer-codex + reviewer-claude 双方独立共识 + lead temp-revert 复现] restart-controller.ts:129 — `setCodexSandbox` 在 closeSession 之后、createSession try 之外，DB write throw → 会话死态无回滚无报错

两 reviewer 独立指向同一弱点。冷切序列：① `closeSession(OLD)`（line 124，已销毁旧 thread + sessions Map 删 entry）→ ② `setCodexSandbox`（line 129，**裸调，在 try 之外**）→ ③ `try { createSession }`（line 133）。若 ② 的 better-sqlite3 同步 `.run()` throw（SQLITE_BUSY / disk full / corrupt），异常直接冒出 IIFE → caller，**跳过** catch 的全部补救（rollback DB + emit error message）。

```ts
// 修前
await this.ctx.closeSession(sessionId);          // ① OLD thread 已死
sessionRepo.setCodexSandbox(sessionId, sandbox); // ② ← throw 在此则下方 catch 接不到
const updatedRec = sessionRepo.get(sessionId);
if (updatedRec) eventBus.emit('session-upserted', updatedRec);
try {
  const handle = await this.ctx.createSession({...});  // ③ 只有这里的 throw 才被 catch
```

**lead 验证**：
1. `setCodexSandbox`（core-crud.ts:203-208）直接 `getDb().prepare(...).run(...)` 无 try/catch → 能抛 ✅
2. 占位 message「⚠ 正在切换 Codex sandbox…重启 thread 中…」(line 108-117) 已 emit；② throw 后无 finished / 无 error bubble → 用户**卡在占位文案** ✅
3. ipc/adapters.ts:395 注释明示契约「adapter.restartWithCodexSandbox 内部已 emit error / 回滚 DB」→ ② throw 窗口违反此契约 ✅
4. 自愈性：closeSession 已 `sessions.delete` → 下条 sendMessage → sessions miss → recoverer 自愈（用 OLD sandbox 因写失败）→ **可自愈但切档静默失败 + 占位卡死**，非永久损坏 → MED 非 HIGH ✅
5. **temp-revert 复现**：forward set 移回 try 外 → MED test 断言「emit error message」失败（修前无 error bubble）✅

**reviewer-claude 补充 2 细节（codex 未提）**：
- **(a) 回滚自身无保护**：catch 内 `setCodexSandbox(oldSandbox)` 同样裸调 — createSession throw 后回滚 DB write **再** throw（持续性故障）则 error message emit 永不执行，且回滚 throw **掩盖原始 err**（createSession 错因丢失）。temp-revert 复现：rethrow 拿到 `'rollback DB still failing'` 而非 `'codex spawn original failure'` ✅
- **(b) cross-adapter 对称**：claude restart-controller.ts:378 `setClaudeCodeSandbox` 是**完全相同**结构（DB write 在 try 之前）→ parity-shared latent pattern，claude 侧留 follow-up。

**修法**：
- forward `setCodexSandbox + get + emit` 移进 try → DB write throw 走 catch emit error 收口占位
- catch 内 rollback write 包独立 try/catch → 回滚失败仅 warn（加 logger import），原始 err 仍透传 + error message 仍 emit

### [LOW ✅ reviewer-codex + reviewer-claude 双方独立同向] translate.ts:403 — loader-warning filter `'failed to deserialize'` 单独命中过宽，吞真 turn-level ErrorItem

两 reviewer 独立指出。`LOADER_WARNING_PATTERNS = ['Ignoring malformed', 'failed to deserialize']` + `.some(includes)` OR 任一命中即 `console.warn` 静默不 emit。`'failed to deserialize'` 是 serde 通用短语，codex 跑工具拿到畸形 JSON / MCP tool result 反序列化失败等**真 turn-level 错误**也含此短语 → 被静默吞掉用户看不到。

```ts
// 修前
const LOADER_WARNING_PATTERNS = ['Ignoring malformed', 'failed to deserialize'];
const isLoaderWarning = LOADER_WARNING_PATTERNS.some((pat) => item.message.includes(pat));
if (isLoaderWarning) { logger.warn(...); return; }  // ← 真 turn error 含此短语也被吞
```

**lead 验证**：真实 loader warning 形如 `"Ignoring malformed agent role definition: failed to deserialize ... invalid type: map"`（translate.ts:393 注释样例）— `'Ignoring malformed'` 前缀是 loader 专属锚点且与 `failed to deserialize` 同句共现。standalone `'failed to deserialize response'`（无 loader 锚点）= 真 turn error 不该吞 ✅

**修法**：filter 收窄到 loader 专属锚点 `item.message.includes('Ignoring malformed')`（弃用 OR-any 数组）。只含 `failed to deserialize` 不含锚点的真 turn-level error 走下方 emit error 给用户看。+2 回归 test（标准 loader warning 仍 suppress / standalone deserialize 仍 emit）。

### [INFO ✅ reviewer-claude] translate.ts:6 — 顶部映射表注释与 error 分支 loader-filter 实现 drift

顶部映射表 `item.completed{error} → message(error)` 未反映 loader-warning filter（部分 error item 走 console.warn 不 emit）→ 补一句「（loader warning 子类含 'Ignoring malformed' 走 console.warn 不 emit）」。

### [INFO ❓ 未验证 reviewer-claude，记 follow-up 不改代码] translate.ts:207 — fatal error emit finished 后不阻断后续事件，潜在双 finished

reviewer-claude 自标 *未验证*。`case 'error'` fatal 分支 emit `finished` 后 `return` 但不 break runTurnLoop `for await` 流；若 codex stream 在 fatal error 后仍吐 `turn.completed` / `turn.failed`，translate 会再 emit 一条 finished → 双 finished。

**lead 裁决 ❓ 不改代码**：codex-sdk `dist/index.d.ts:159` 注释 ThreadErrorEvent 是「unrecoverable error emitted directly by the event stream」强烈暗示 stream 终态事件（其后 AsyncIterable 应结束）。无法在不实跑 codex 子进程前提下证实「fatal 后流是否真不再吐事件」。加 per-turn finished-idempotency guard 无验证需求且可能误抑制合法事件 → 记 follow-up future-proof，不投机改代码（符合 §finding 契约「未验证强制降级 + 纯推理不改」）。

## 修复清单

| # | 文件:行 | 严重度 | 修法 | 验证 |
|---|---|---|---|---|
| 1 | restart-controller.ts:129 | MED ✅ | forward setCodexSandbox 纳入 try + 回滚包 try/catch 防掩盖原 err（加 logger） | 双方独立共识 + lead trace（core-crud 无 try/catch + ipc 契约 + claude parity）+ temp-revert 双 test 复现 |
| 2 | translate.ts:403 | LOW ✅ | loader-warning filter 收窄到 `'Ignoring malformed'` 锚点（弃 OR-any） | 双方独立同向 + lead 验证 loader 样例 + 2 回归 test |
| 3 | translate.ts:6 | INFO ✅ | 映射表注释补 loader-filter 说明 | reviewer-claude |
| — | translate.ts:207 | INFO ❓ | 双 finished *未验证* → 记 follow-up 不改代码 | reviewer-claude 自标未验证 + lead 裁 SDK 契约暗示终态 |

## 验证

```
typecheck（双配置 tsconfig.node + tsconfig.web）：PASS
node_modules/.bin/vitest run src/main/adapters/codex-cli：12 files / 135 passed（131 既有 + 4 新）
MED temp-revert：forward set 移回 try 外 + 回滚裸调 → 2 MED test FAIL
  （forward-throw 无 error bubble / rollback-mask rethrow 'rollback DB still failing' 掩盖原 err）→ 确定性复现 + 证 test 守门
```

## 结论

D2。codex thread-loop case 1/2/3 fork-detect（经 D1 修复后维度正确）+ translate 全 8 ThreadEvent + 8 ThreadItem 字段提取（对照 SDK d.ts 逐条核过）+ resume-path-await earlyErrCb 4 资源 cleanup + 单飞 while-loop 都扎实，0 HIGH。唯一真问题 MED 是冷切 sandbox 失败窗口（双方独立共识 + temp-revert 复现）：forward DB write 在 try 外 throw → 静默死态 + 占位卡死 + 违反 IPC 契约，连带回滚自身掩盖原 err；属 claude/codex parity-shared latent pattern（claude 侧留 follow-up）。LOW loader-filter 过宽双方同向修。1 INFO 注释 drift 修，1 INFO 双 finished *未验证* 记 follow-up 不投机改。

## Follow-up（留用户回来决策）

1. **[MED parity] claude restart-controller.ts:378 同款 setClaudeCodeSandbox throw 窗口**（REVIEW_80 MED (b)）— claude restartWithClaudeCodeSandbox / restartWithPermissionMode 的 forward DB write 同在 try 之外，与本批 codex MED 同款 latent pattern。建议对称修（Batch C 已收官，留用户决定是否回补 claude 侧 / 或 Batch G store 批顺带）。
2. **[INFO 未验证] translate.ts:207 fatal error 后潜在双 finished**（REVIEW_80 INFO）— 需实跑 codex 子进程验证「fatal ThreadErrorEvent 后 stream 是否真终止」。若 SDK 不保证终态则需加 per-turn finished-idempotency guard。

> 下一子批 D3：recoverer/* + codex-recoverer-messages + codex-jsonl-fallback（断连自愈 / jsonl 探测 / fallback 路径）。
