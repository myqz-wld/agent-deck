---
review_id: REVIEW_43
title: archive-toctou-fix K3/baton archive helper TOCTOU race + reasonKind 'probe-throw' + EventMap union narrow 两轮异构对抗 review × fix
created_at: 2026-05-15
plan_id: archive-toctou-fix-20260515
worktree_path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/archive-toctou-fix-20260515
base_commit: 1456824
final_commit: ddea608
parent_review_id: REVIEW_42
heterogeneous_dual_completed: true
---

# REVIEW_43 — archive-toctou-fix R1 修法决策 + R2 实施代码两轮异构对抗 review × fix

## 触发场景

REVIEW_42 §已知 follow-up 三条数据层耦合一次性收口:

- **MED race window**(R3 双方共识): K3 `archiveSourceSessionWithEmit` + mcp `runBatonCleanup` 两个 helper 都有同款 TOCTOU race — `getSession` sync 探针 OK 后到 `await deps.archive(sid)` 之间至少一个 microtick(`await Promise.resolve()` 等),lifecycle scheduler / 用户手动 close / DB reaper 任一可在窗口内删 row → `setArchived` 裸 UPDATE 不查 `.changes` 对缺失 row silent resolve → `sessionManager.archive` 拿 updated == null 只是不 emit `session-upserted` 不抛错 → helper 走 archive ok 不 emit `caller-archive-failed` → 用户完全无感知 row 已被删
- **LOW probe-throw 隐藏 UI 重试**(R2 reviewer-codex LOW-1): `getSession` 抛错(SQLite locked / DB read failure)不等价于 row 不存在,重试可能有效。但当前两个 helper 走 try/catch 兜底 null → 触发 `reasonKind='row-missing'` 路径,文案走「记录不可用」,P2 renderer 也会按 `row-missing` 不展示重试按钮
- **INFO TOOL_DISPLAY_NAME union narrow**: `Record<string, string>` 软兜底,加新 emit 触发点忘加映射时 fallback 到 raw 字符串(IPC channel 内部名 'SessionHandOffSpawn' 暴露)

## 方法

### Scope = plan 2 commit / 13 文件 / +467/-66 LOC

**主线 2 commit**:
- `3c27b98` Phase 2 实施(R1 共识修法 A+ + 加 'probe-throw' + union narrow + IPC 幂等静默 + adapters.ts attachments cleanup): archive.ts SessionRowMissingError + setArchived `.changes === 1` throw / event-bus.ts EventMap toolName union narrow + reasonKind 加 'probe-throw' / baton-cleanup.ts + sessions-hand-off-helper.ts probe try/catch 拆 + archive instanceof / ipc/sessions.ts SessionArchive/SessionUnarchive 幂等静默 + 顶部 import / ipc/adapters.ts AdapterSendMessage 把 unarchiveOnUserSend 进 try/catch 共享 attachments cleanup / main/index.ts TOOL_DISPLAY_NAME narrow Record + listener 三档文案 / 守门 test 11 文件 (8 prod + 3 test) / +462/-62
- `ddea608` R2 fix(reviewer-claude MED-1 死代码清理 + reviewer-codex LOW-1 注释同步): main/index.ts 删 isRetryable 死代码 + void workaround / shared/ipc-channels.ts:141-153 注释 union 同步 / mocks/session-repo.ts LOW-2 acceptable defer 注释化 (3 文件 / +11/-10)

### 异构对抗 reviewer

**两轮 heterogeneous_dual_completed: true**(应用 `agent-deck:deep-code-review` SKILL teammate 模式编排)。

| Reviewer | 模型 | R1 修法决策 | R2 实施代码 |
|---|---|---|---|
| **reviewer-claude** | Opus 4.7 | sid `15402a93` | 同 R1 复用(跨轮 mental model 持久化) |
| **reviewer-codex** | gpt-5.5 xhigh(wrapper) | sid `b0eed8d4` | 同 R1 复用 |

R1+R2 复用同对 reviewer 跨轮 mental model 持久化 + reply 自动注入 lead conversation flow(详 user CLAUDE.md §决策对抗 + 应用 CLAUDE.md §Universal Team Backend)。

## R1 修法决策三态裁决

R1 是「修法决策 review」(scope = 选 A/B/C 修法策略 + 评估扩展合理性),非「实施代码 review」。

### 共识 ✅ 真问题(双方独立提出修法推荐)

| ID | 严重度 | 内容 | 异构强证据 |
|---|---|---|---|
| **Q1** | HIGH | 修法 A — `setArchived` 检查 `.changes === 1` throw `SessionRowMissingError`(SQL 单点 setter throw 是 SSOT,所有 caller 通过 throw 自然感知) | reviewer-claude 推 A+ / reviewer-codex 推 A+ 加 `SessionRowMissingError` 可识别错误。双方独立从 SSOT 角度推 A,反对 B(只补 archive 留 unarchive 同款债)+ C(REVIEW_42 R3 双方已共识必修不接受) |
| **Q2** | MED | 加 'probe-throw' reasonKind 三档区分(row-missing 不重试 / probe-throw + archive-throw 可重试,文案不同) | 双方独立从语义正交 + UI 决策有意义 + 可观测性 + 同源耦合最高效 角度推荐加 |
| **Q3** | MED | TOOL_DISPLAY_NAME `Record<string, string>` → `Record<CallerArchiveFailedToolName, string>` union narrow + 顺手 narrow `RunBatonCleanupInput.toolName: 'archive_plan' \| 'hand_off_session'`(K3 走独立 helper 不经此 union 仅 2 值) | 双方独立确认无负面副作用 + 编译期守门(加新 emit 触发点忘加映射时 tsc fail) |
| **MED-IPC** | MED | IPC SessionArchive/SessionUnarchive `instanceof SessionRowMissingError` 幂等静默 return true(用户主动操作 row 已不在 = 等价已归档无害,不 emit 避免打扰) | reviewer-claude 推选 (c) 平衡(try/catch + emit 通用通道) / reviewer-codex 推 main handler `SessionRowMissingError` 幂等静默。lead 现场验证 HistoryPanel.tsx:106 / SessionCard.tsx:39 裸 await 无 catch + 选 codex 立场更纯(emit 通道是给 mcp/K3 自动归档场景设计的,IPC 用户主动操作不走以避免 noise) |

### R1 反驳轮 ✅(reviewer-claude 撤回 LOW 立场认同 reviewer-codex HIGH)

| ID | 立场 | 反驳轮结论 |
|---|---|---|
| **HIGH-unarchive** | reviewer-codex HIGH(throw 冒泡更合理): A 下 unarchive row-missing 应**终止用户本次续聊**,由 Composer 现有 catch 展示错误。recoverer 已有先例 throw(line 236-238 / 261-264) | reviewer-claude 反驳轮**撤回 LOW 立场** ✅ 认同 codex HIGH:现场 grep 验证 v001_init.sql:18-53 events/file_changes/summaries/team_members 表 FK ON DELETE CASCADE + manager.ts:149-186 ensure 缺 row 真会重建空 record + recentlyDeleted blacklist 不拦 lifecycle scheduler purge → 兜底 try/catch 路径下用户得到 sid 不变但子表全空的 ghost session,silent 历史丢失 ❌ + recoverer.ts:259-260 注释明文化 by design throw + 保留 archived 状态范本 + sdk-bridge sendMessage 不 catch 让 throw 冒泡走 IPC reply error → renderer Composer inline error。**最终落地**: 修法 A 后 recoverer.ts × 2 不需 try/catch unarchive throw,自然冒泡(零改动 recoverer);唯一 nuance IPC SessionUnarchive try/catch + console.warn 静默(用户主动「右键取消归档」row 已不在无害不必 throw 打扰) |

## R2 实施代码三态裁决

scope: Phase 2 实施 commit `3c27b98` 11 文件 diff(reviewer-claude 单方 1 MED + 3 LOW + 2 INFO,reviewer-codex 单方 0 HIGH/MED + 3 LOW)。

### 真问题(必修)

| ID | 严重度 | 内容 | 出处 + 验证 | 落地 commit |
|---|---|---|---|---|
| **MED-1 (claude)** | MED | `main/index.ts:314-346` `isRetryable` 死代码 + `void isRetryable;` workaround YAGNI 违反(payload.reasonKind switch 三分支已隐式覆盖逻辑,P1 不消费 derived state 应删) | reviewer-claude 单方 + lead 现场验证 main/index.ts grep `isRetryable` 全文 100% 不被读 | ddea608 |
| **LOW-1 (codex)** | LOW | `shared/ipc-channels.ts:143` 注释 reasonKind union 漏更新 'probe-throw'(运行时已是 union 但 doc 滞后) | reviewer-codex 单方 + lead 现场验证 grep `event-bus.ts:61` 真实 union 已 narrow + renderer/preload 当前未消费 IPC channel | ddea608 |

### ❓ 不修留独立 follow-up(LOW acceptable defer 或 P2 plan)

| ID | 严重度 | 内容 | 出处 + 判定 |
|---|---|---|---|
| **LOW-2 (codex)** | LOW | `mocks/session-repo.ts:75` setArchived 与生产 throw 语义分叉(mock 仍 no-op 静默)→ 后续 manager/recoverer/tool 测试覆盖不到 race 语义 | **尝试修撞 vi.mock hoisting 陷阱**(mock factory 内 import `SessionRowMissingError` 被 vi.mock 替换的同 module → TDZ ReferenceError → 12 个 makeSessionRepoMock caller 测试 failed)。修法需在每个 vi.mock factory 加 importActual + spread,工作量大属测试基建升级。回退 + 文档化标 acceptable defer 到 P2 plan,与 reviewer-codex 自评「scope 评估值不值,如有现成 pattern 建议补」一致 |
| **LOW (双方共识 defer)** | LOW | IPC SessionArchive/SessionUnarchive handler 缺 integration test(handler try/catch + instanceof + return true / throw 路径未单测) | reviewer-claude + reviewer-codex 双方 LOW (defer): handler 行为极简单 11 行;写 IPC handler 集成测试需拉起 Electron + IPC 全栈 ROI 低;实际行为通过 archive.test.ts(setter throw 行为)+ caller 链 unit test(handler 调用 caller chain)间接验证 |
| **LOW (claude P2 plan)** | LOW | renderer `HistoryPanel.tsx:106/110` + `SessionCard.tsx:39` 裸 await 无 catch — 修法 A 后非 SessionRowMissingError 异常 trigger unhandled rejection | reviewer-claude 单方 + lead 现场 grep 验证 3 处全裸 await。**为什么标 LOW**: row-missing 路径(80%+ race 触发场景)已被 IPC handler 静默吞;实际能撞 throw 的只剩 FK / DB locked 极少见;修前 sessionManager.archive 已可能 throw 不**新增**异常点;ipc/sessions.ts:46-47 注释已明示 P2 toast plan 收口 |
| **LOW (claude P2 plan)** | LOW | 修法 A 后 `recoverer.ts` unarchive throw 给 renderer 的 error.message 是开发者文案("setArchived no-op: ... probe 后 row 被外部删 - lifecycle scheduler purge / ...") | reviewer-claude 单方 + 评估「现有 recoverer.ts:236-238 throw 文案 (`session ${sid} not found`) 也是开发者文案,**没引入新 UX 退化**,本 plan 只是沿用同款不友好」+ P2 plan 加 IPC error 文案中间件统一映射 SessionRowMissingError → user-friendly 文案("会话已不可用,请刷新历史列表"),不是本 plan scope |
| **INFO (claude)** | INFO | SessionRowMissingError `instanceof` + `err.name` 双判别 — 优雅但其实 instanceof 单判别已够 | reviewer-claude 单方 + 评估当前 vite/esbuild 单 entry build 跨 module instanceof 不会 prototype chain 失效,name 字段是 future-proof(web worker / cross-realm structuredClone / error 序列化场景下兜底)。零成本保留是工程美学,不必修 |
| **INFO ×9 (claude)** | INFO | 实施细节验证维度 ✅ 全过(9 维度 setArchived 严格检查 / instanceof 双判别 / caller 链全审计 / helper 行为对称 / TOOL_DISPLAY_NAME 强制覆盖 / listener 三档文案 / attachments cleanup 共享 / RunBatonCleanupInput.toolName narrow / 测试覆盖) | reviewer-claude 单方 acknowledge ✅ 全过 |
| **INFO ×3 (codex)** | INFO | SQLite in-memory 验证 same-value UPDATE 返回 changes=1 + missing id changes=0 / git diff check 无 whitespace / 沙盒阻止 vitest 收集执行 | reviewer-codex 单方 acknowledge |

## 修复条目

### Phase 2 实施(详 commit `3c27b98`)

#### 修法 A SSOT setter throw

- `src/main/store/session-repo/archive.ts`:
  - 新建 `SessionRowMissingError` extends Error class(`readonly name = 'SessionRowMissingError'` + ctor 含 sid + race window 提示)
  - `setArchived` 检查 `result.changes !== 1` → throw SessionRowMissingError(包括防御性 `> 1` 路径,sessions.id PRIMARY KEY 应保证 ≤1 但严防边角)
- `src/main/store/session-repo/index.ts`: re-export SessionRowMissingError 给 caller facade

#### 'probe-throw' reasonKind 推全链路

- `src/main/event-bus.ts`: EventMap 'caller-archive-failed' payload:
  - `toolName: 'archive_plan' | 'hand_off_session' | 'SessionHandOffSpawn'`(union narrow)
  - `reasonKind: 'row-missing' | 'probe-throw' | 'archive-throw'`(加 probe-throw)
  - 更新 jsdoc 描述三档语义(row-missing 重试无效 / probe-throw + archive-throw 可重试)
- `src/main/agent-deck-mcp/tools/handlers/baton-cleanup.ts`:
  - `RunBatonCleanupInput.toolName` 从 `string` narrow 到 `'archive_plan' | 'hand_off_session'`(K3 走独立 helper union 仅 2 值)
  - probe try/catch 拆出来 emit `'probe-throw'`(不再吞错归 row-missing)
  - archive try/catch 内 `instanceof SessionRowMissingError` 区分 'row-missing' vs 'archive-throw'(R1 reviewer-codex MED-1 修法 — 修前 catch-all 把 setter no-op 误归 'archive-throw' 误导用户)
- `src/main/ipc/sessions-hand-off-helper.ts`:
  - `ArchiveSourceSessionDeps.emitArchiveFailed` payload reasonKind union 加 'probe-throw'
  - 同款 probe try/catch 拆 emit 'probe-throw' + archive try/catch 内 instanceof 区分(行为对称 mcp baton-cleanup)

#### IPC handler 幂等静默 + attachments cleanup

- `src/main/ipc/sessions.ts`:
  - 顶部 import `SessionRowMissingError` from `@main/store/session-repo`
  - `SessionArchive` handler: try/catch + `instanceof SessionRowMissingError` 静默 return true(用户主动归档已删 row 等价已归档无害)+ 其他 throw bubble
  - `SessionUnarchive` handler: 同款 try/catch + 静默 return true(用户「右键取消归档」row 已不在无害不必 throw 打扰)
- `src/main/ipc/adapters.ts`: AdapterSendMessage 把 `unarchiveOnUserSend` 移进 try/catch 块,与 `adapter.sendMessage` 共享 attachments cleanup(修法 A 后 unarchive throw 必须走 cleanup 兜底,否则 attachments 残留磁盘 leak)

#### main listener union narrow + 三档文案

- `src/main/index.ts`:
  - 顶部 `import type { EventMap } from './event-bus'`
  - `type CallerArchiveFailedToolName = EventMap['caller-archive-failed'][0]['toolName']`
  - `TOOL_DISPLAY_NAME: Record<CallerArchiveFailedToolName, string>` 强制完整覆盖(加新 emit 触发点忘加映射时 tsc fail)
  - listener body 三档文案(archive-throw 「可重试归档」 / probe-throw 「DB 异常可稍后重试」 / row-missing 「记录不可用」)

#### 守门 test 新增 / 修改

- `src/main/store/session-repo/__tests__/archive.test.ts`(新建): 7 case 覆盖 setArchived 正常归档(.changes=1) + 取消归档(ts=null + .changes=1) + row missing(.changes=0 → throw SessionRowMissingError) + row missing 取消归档路径 + 防御 .changes>1 + SessionRowMissingError class instanceof + name 字段 + caller 链 instanceof 判别模式
- `src/main/agent-deck-mcp/__tests__/baton-cleanup.test.ts`:
  - case 7 改 'probe-throw'(getSession 抛错 → reasonKind='probe-throw' 不再 row-missing)
  - case 8 改 generic Error → reasonKind='archive-throw'
  - 新增 case 8b: archiveFn 抛 SessionRowMissingError → race window → reasonKind='row-missing' instanceof 判别
  - 矩阵注释更新
- `src/main/ipc/__tests__/sessions.test.ts`:
  - case 改 archive 抛 generic Error → 'archive-throw'
  - 新增 case archive 抛 SessionRowMissingError → race window → 'row-missing'
  - 新增 case getSession 抛错 → 'probe-throw' 替换原 row-missing case

### R2 fix(详 commit `ddea608`)

#### MED-1 (reviewer-claude) — 删 isRetryable 死代码 + void workaround

- `src/main/index.ts:308-352`: 删 `isRetryable` 计算 + `void isRetryable;` workaround + 提及注释。`payload.reasonKind` switch 三分支已隐式覆盖 isRetryable 逻辑,P1 不消费 derived state 是 YAGNI 违反。P2 toast plan 时 5 行瞬间补回

#### LOW-1 (reviewer-codex) — ipc-channels.ts 注释 union 同步

- `src/shared/ipc-channels.ts:141-153`: 注释 reasonKind union 加 'probe-throw' + toolName narrow union 描述 + 重试按钮文案三档区分('archive-throw' / 'probe-throw' 显示重试 / 'row-missing' 仅告知)。contract/doc 与 event-bus.ts EventMap 同步

#### LOW-2 (reviewer-codex acceptable defer)

- `src/main/__tests__/_shared/mocks/session-repo.ts:75-83`: 注释化为何不修(vi.mock hoisting 陷阱 + 12 文件影响 + 测试基建升级 scope) + 引用 reviewer-codex 自评 acceptable defer

## 验收

- typecheck: claude + codex 双 tsconfig 全过(R2 final commit `ddea608`)
- vitest: **577 passed / 64 skipped**(641 total,better-sqlite3 ABI 环境守门 by design;比 R3 base 525 多 52 个 case 覆盖 R1+R2 fix + plan 新增 archive.test.ts 7 case + caller 链 instanceof 判别守门)
- 异构对抗强度: ✅ **完整**(`heterogeneous_dual_completed: true`,两轮全部双方独立 reply + R1 反驳轮 reviewer-claude 撤回 LOW 立场认同 reviewer-codex HIGH + R2 复用同对 reviewer 跨轮 mental model 持久化)
- R1 共识真问题(Q1+Q2+Q3+MED-IPC+HIGH-unarchive 反驳轮)+ R2 真问题(MED-1+LOW-1)= **8 条 ✅ 全修**

## 已知 follow-up(本 plan 不做)

### LOW 级 — session-repo mock setArchived throw 与生产分叉(测试覆盖盲区)

**问题**: `mocks/session-repo.ts:75` setArchived 仍 no-op 静默(id 不在时不 throw),与生产 setArchived throw SessionRowMissingError 行为分叉 → 后续 manager/recoverer/tool 测试用 mock 不覆盖修法 A 后 race window 路径(测试假设 happy path,真生产撞 race 时 caller 链 instanceof 判别行为不被守门)。

**为什么不修**: vi.mock 把 `@main/store/session-repo` 整个 module 替换 → mock factory 内 `import { SessionRowMissingError } from '@main/store/session-repo'` 撞 TDZ ReferenceError → 12 个 makeSessionRepoMock caller 测试 failed。修法需在每个 vi.mock factory 加 importActual + spread SessionRowMissingError class,工作量大且属测试基建升级。reviewer-codex 自评「scope 评估值不值,如有现成 pattern 建议补」与本判定一致。

**修法**: 留 P2 plan 重组 vi.mock 模式(可能引入 mocks/session-repo-with-throw.ts 独立 factory + 测试调用方主动 opt-in)。

### LOW 级 — IPC SessionArchive/SessionUnarchive handler 缺 integration test(双方 defer)

**问题**: `ipc/sessions.ts` 修法 A 后 try/catch + instanceof + return true / throw 路径无直接 unit test。

**为什么不修**: handler 行为极简单(11 行 / 路径分支 trivial)+ 写 IPC handler 集成测试需拉起 Electron + IPC 全栈 ROI 低 + 实际行为通过 archive.test.ts(setter throw 行为)+ caller 链 unit test(handler 调用 caller chain)间接验证。reviewer-claude 与 reviewer-codex 双方共识 defer。

### LOW 级 — renderer 裸 await 无 catch + recoverer error.message UX(P2 plan 收口)

**问题**:
- HistoryPanel.tsx:106/110 + SessionCard.tsx:39 裸 await window.api.archiveSession/unarchiveSession 无 catch — 修法 A 后非 SessionRowMissingError 异常 trigger React 端 unhandled rejection
- recoverer.ts × 2 unarchive throw 给 renderer 的 error.message 是开发者文案不友好

**为什么不修**: 修法 A 后 row-missing 路径(80%+ race 触发场景)已被 IPC handler 静默吞,实际能撞 throw 的只剩 FK / DB locked 极少见;修前 sessionManager.archive 已可能 throw 不**新增**异常点;现有 recoverer.ts:236-238 已是开发者文案不引入新 UX 退化。

**修法**: 留 P2 toast plan(renderer 全局 toast 容器 listen IPC `CallerArchiveFailed` + 重试按钮 + IPC error 文案中间件统一映射 SessionRowMissingError → 友好文案)。

### INFO 级 — 工程美学保留(不修)

- `instanceof` + `err.name` 双判别保留(reviewer-claude INFO): future-proof for web worker / cross-realm structuredClone / error 序列化场景兜底,零成本

## 关联 changelog

[CHANGELOG_119.md](../changelog/CHANGELOG_119.md)
