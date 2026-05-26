# CHANGELOG_119

## 概要

archive-toctou-fix-20260515 plan 收口（REVIEW_42 §已知 follow-up MED race window + LOW probe-throw + INFO TOOL_DISPLAY_NAME union 三条数据层耦合一次性收口）—— K3/baton archive helper TOCTOU race window fix(setArchived `.changes === 1` throw `SessionRowMissingError` SSOT 修法 A)+ reasonKind 'probe-throw' 加值推全链路 + EventMap toolName + TOOL_DISPLAY_NAME union narrow 强制完整覆盖 + IPC SessionArchive/Unarchive 幂等静默 + adapters.ts attachments cleanup 共享。共 2 commit / 13 文件 / +467/-66 LOC / typecheck 双端 + vitest 577/641 全过(64 skipped 是 better-sqlite3 ABI 环境问题)。详 [REVIEW_43.md](../reviews/REVIEW_43.md)。

## 变更内容

### Commit 1 — Phase 2 实施（commit 3c27b98）

R1 三态裁决后用户拍板修法 A+(setArchived throw + SessionRowMissingError 可识别错误)+ Q2 加 'probe-throw' + Q3 union narrow + MED-IPC 幂等静默 + R1 反驳轮共识 recoverer 零改动。11 文件 / +462/-62。

#### 修法 A SSOT setter throw

- `src/main/store/session-repo/archive.ts`:
  - 新建 `SessionRowMissingError` extends Error class(`readonly name = 'SessionRowMissingError'` + ctor 含 sid + race window 提示)— caller 链通过 `instanceof` 判别,反射准确的 reasonKind 给 UI
  - `setArchived` 检查 `result.changes !== 1` → throw `SessionRowMissingError`(包括防御性 `> 1` 路径,sessions.id PRIMARY KEY 应保证 ≤1 但严防边角)
- `src/main/store/session-repo/index.ts`: re-export `SessionRowMissingError` 给 caller facade(避免深 import './archive')

#### 'probe-throw' reasonKind 推全链路

- `src/main/event-bus.ts`: EventMap 'caller-archive-failed' payload `toolName` 从 `string` narrow 到 `'archive_plan' | 'hand_off_session' | 'SessionHandOffSpawn'` union + `reasonKind` 从 2 档 narrow 到 3 档 union(`'row-missing' | 'probe-throw' | 'archive-throw'`)+ 更新 jsdoc 描述三档语义
- `src/main/agent-deck-mcp/tools/handlers/baton-cleanup.ts`:
  - `RunBatonCleanupInput.toolName` 从 `string` narrow 到 `'archive_plan' | 'hand_off_session'`(K3 走独立 helper union 仅 2 值)
  - probe try/catch 拆出来 emit `'probe-throw'`(不再吞错归 row-missing — LOW probe-throw bug fix)
  - archive try/catch 内 `instanceof SessionRowMissingError` 区分 'row-missing'(setter no-op race window)vs 'archive-throw'(R1 reviewer-codex MED-1 修法 — 修前 catch-all 把 setter no-op 误归 'archive-throw' 误导 UI 显示「重试归档」按钮但 row 真不存在重试无效)
- `src/main/ipc/sessions-hand-off-helper.ts`:
  - `ArchiveSourceSessionDeps.emitArchiveFailed` payload reasonKind union 加 'probe-throw'
  - 同款 probe try/catch 拆 emit 'probe-throw' + archive try/catch 内 instanceof 区分(行为对称 mcp baton-cleanup helper)

#### IPC handler 幂等静默 + attachments cleanup

- `src/main/ipc/sessions.ts`:
  - 顶部 import `SessionRowMissingError`
  - `SessionArchive` handler: try/catch + `instanceof SessionRowMissingError` 静默 return true(用户主动归档已删 row 等价已归档无害,通知反而打扰;P1 emit caller-archive-failed 通道是给 mcp/K3 自动归档场景设计的,IPC 用户主动操作不走该通道避免 noise)+ 其他 archive 异常仍 throw bubble
  - `SessionUnarchive` handler: 同款 try/catch + 静默 return true(用户「右键取消归档」row 已不在 = 「已经不在归档列表」无害不必 throw 打扰)
- `src/main/ipc/adapters.ts`: AdapterSendMessage 把 `unarchiveOnUserSend` 移进 try/catch 块,与 `adapter.sendMessage` 共享 attachments cleanup(修法 A 后 setArchived throw 必须走 cleanup 兜底,否则 attachments 残留磁盘 leak;throw 仍冒泡走 IPC reply error → renderer Composer inline error,与 reviewer-codex R1 HIGH「row 真不存在让 throw 冒泡更合理」立场一致)

#### main listener union narrow + 三档文案

- `src/main/index.ts`:
  - 顶部 `import type { EventMap }` from './event-bus'
  - `type CallerArchiveFailedToolName = EventMap['caller-archive-failed'][0]['toolName']`
  - `TOOL_DISPLAY_NAME: Record<CallerArchiveFailedToolName, string>` 从 `Record<string, string>` narrow,强制完整覆盖(加新 emit 触发点 EventMap union 加值时忘加 TOOL_DISPLAY_NAME 条目时 tsc 编译期 fail — ✅ feature)
  - listener body 三档文案区分 reasonKind 语义:
    - `'archive-throw'`: 「原会话未归档,可重试归档（<sid>...,工具:<tool>）」
    - `'probe-throw'`: 「数据库异常无法探针原会话,可稍后重试归档（<sid>...,工具:<tool>）」(区分 archive-throw 让用户知道是 DB 问题)
    - `'row-missing'`: 「原会话记录不可用,归档未完成（<sid>...,工具:<tool>）」(仅告知)

#### 守门 test 新增 / 修改

- `src/main/store/session-repo/__tests__/archive.test.ts`(新建 100 行 / 7 case): SSOT setArchived 行为(正常 .changes=1 / 取消归档 ts=null+.changes=1 / row missing .changes=0 throw / row missing 取消归档路径 / 防御 .changes>1)+ SessionRowMissingError class(instanceof Error + name 字段 + caller 链 instanceof 判别模式 verify)
- `src/main/agent-deck-mcp/__tests__/baton-cleanup.test.ts`:
  - case 7 改 'probe-throw' 路径(getSession 抛错 → reasonKind='probe-throw' 不再 row-missing,UI 显示「重试归档」按钮)
  - case 8 改 generic Error → reasonKind='archive-throw'(明确 generic Error 走非 row-missing 分支)
  - 新增 case 8b: archiveFn 抛 SessionRowMissingError → race window → reasonKind='row-missing'(instanceof 判别准确归类)
  - 矩阵注释更新反映三档 reasonKind
- `src/main/ipc/__tests__/sessions.test.ts`:
  - case 改 archive 抛 generic Error → reasonKind='archive-throw'
  - 新增 case archive 抛 SessionRowMissingError → race window → reasonKind='row-missing'
  - 新增 case getSession 抛错 → reasonKind='probe-throw' 替换原 row-missing case

### Commit 2 — R2 异构对抗 fix（commit ddea608）

R2 reviewer-claude 单方 1 MED + 3 LOW + 2 INFO,reviewer-codex 单方 0 HIGH/MED + 3 LOW。**真问题 2 条全修**(MED-1 + LOW-1),LOW-2 撞 vi.mock hoisting 陷阱 acceptable defer to P2。3 文件 / +11/-10。

#### MED-1 (reviewer-claude) fix — 删 isRetryable 死代码 + void workaround

- `src/main/index.ts:308-352`: 删 `isRetryable` 计算 + `void isRetryable;` workaround + 提及注释。理由:`payload.reasonKind` switch 三分支已隐式覆盖 isRetryable 逻辑(`'archive-throw' || 'probe-throw'` → 「可重试」分支 / `'row-missing'` → 「仅告知」分支),P1 不消费的 derived state 是 YAGNI 违反。P2 toast plan 加回时 5 行代码瞬间补

#### LOW-1 (reviewer-codex) fix — shared/ipc-channels.ts 注释 union 同步

- `src/shared/ipc-channels.ts:141-153`: 注释 reasonKind union 加 'probe-throw' + toolName 描述加 union narrow + 重试按钮文案三档区分('archive-throw' / 'probe-throw' 显示重试 / 'row-missing' 仅告知)。contract/doc 与 event-bus.ts EventMap 真实 union 同步

#### LOW-2 (reviewer-codex acceptable defer to P2)

- `src/main/__tests__/_shared/mocks/session-repo.ts:75-83`: 尝试改成 throw SessionRowMissingError 与生产对齐,但撞 vi.mock hoisting 陷阱 — `vi.mock('@main/store/session-repo', () => ({ sessionRepo: makeSessionRepoMock() }))` 把 module 整个替换,mock factory 内 import 同 module 的 `SessionRowMissingError` 撞 TDZ ReferenceError → 12 个 makeSessionRepoMock caller 测试 failed。回退 + 文档化为何不修(修法需在每个 vi.mock factory 加 importActual + spread,工作量大属测试基建升级)+ 引用 reviewer-codex 自评 「scope 评估值不值,如有现成 pattern 建议补」一致 acceptable defer

## 不变量保留

- archive 失败 warn-only 仍 by design(let mcp tool ok return 不阻塞 caller 路径),仅在 SQL 单点 setter 加 throw + caller 链通过 instanceof 反射准确 reasonKind(SessionRowMissingError 作为可识别错误是 reviewer-codex MED-1 修法的关键)
- mcp handler 与通知层职责分离(baton-cleanup 通过 eventBus 桥不直接 import notify/visual.ts)— 不变
- helper 抽离避免 sessions.test.ts 拉 Electron import 链(sessions-hand-off-helper.ts 行为对齐 baton-cleanup helper)— 不变
- recoverer.ts × 2 不改(R1 反驳轮共识:throw 自然冒泡走 bridge sendMessage → IPC → renderer Composer inline error 链路,与 line 236-238 / 261-264 已有 throw 风格一致;reviewer-claude 撤回 LOW 立场援引 v001_init.sql ON DELETE CASCADE + manager.ts:169 ensure 缺 row 重建空 record + recoverer.ts:259-260 注释明文化 by design throw 范本)

## ❓ 不修留 follow-up plan

### LOW 级 — session-repo mock setArchived throw 与生产分叉(R2 reviewer-codex LOW-2,acceptable defer)

mock 仍 no-op 静默 → 后续 manager/recoverer/tool 测试覆盖不到修法 A race window 路径。撞 vi.mock hoisting 陷阱无法干净修(详上),留 P2 plan 重组 vi.mock 模式(可能引入 mocks/session-repo-with-throw.ts 独立 factory + 测试调用方主动 opt-in)。

### LOW 级 — IPC SessionArchive/SessionUnarchive handler 缺 integration test(双方 defer)

handler 行为极简单 11 行 + 写 IPC handler 集成测试需拉起 Electron + IPC 全栈 ROI 低 + 实际行为通过 archive.test.ts(setter throw 行为)+ caller 链 unit test 间接验证。reviewer-claude 与 reviewer-codex 双方共识 defer。

### LOW 级 — renderer 裸 await 无 catch + recoverer error.message UX(留 P2 toast plan 收口)

HistoryPanel.tsx:106/110 + SessionCard.tsx:39 裸 await 无 catch + recoverer.ts × 2 unarchive throw 给 renderer 是开发者文案不友好。**为什么不修**: 修法 A 后 row-missing 路径(80%+ race 触发场景)已被 IPC handler 静默吞,实际能撞 throw 的只剩 FK / DB locked 极少见;修前 sessionManager.archive 已可能 throw 不**新增**异常点;现有 recoverer.ts:236-238 已是开发者文案不引入新 UX 退化。**修法**: 留 P2 toast plan(renderer 全局 toast 容器 listen IPC `CallerArchiveFailed` + 重试按钮 + IPC error 文案中间件统一映射 SessionRowMissingError → 友好文案)。

### INFO 级 — 工程美学保留(不修)

`SessionRowMissingError instanceof + err.name` 双判别保留(reviewer-claude INFO): future-proof for web worker / cross-realm structuredClone / error 序列化场景兜底,零成本。当前 vite/esbuild 单 entry build 跨 module instanceof 不会 prototype chain 失效,name 字段是 future-proof。

## 验证

- typecheck: claude + codex 双 tsconfig 全过(R2 final commit `ddea608`)
- vitest: **577 passed / 64 skipped**(641 total,better-sqlite3 ABI 环境守门 by design;比 R3 base 525 多 52 个 case 覆盖 R1+R2 fix + 新增 archive.test.ts 7 case + caller 链 instanceof 判别守门)
- 异构对抗强度: ✅ **完整**(`heterogeneous_dual_completed: true`,两轮全部双方独立 reply + R1 反驳轮 reviewer-claude 撤回 LOW 立场认同 reviewer-codex HIGH + R2 复用同对 reviewer 跨轮 mental model 持久化)
