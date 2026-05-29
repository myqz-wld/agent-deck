# Spike 1 — 13 大文件 architecture dep graph 分析

**plan**: deep-project-review-comprehensive-20260528
**phase**: Phase 4 Step 4.0 read-only architecture spike
**date**: 2026-05-29
**author**: cold-start hand off 7
**baseline commit**: 9a03b46 (Phase 3 R4 polish 后)

## 动机

Phase 4 入口前置必跑 (read-only architecture spike，**不动代码**)，inform 后续 Step 4.1-4.11 user confirm 决策：

- 13 大文件当前依赖图（谁 import 谁 / 谁被谁 import）
- 找 circular dep / 不合理耦合 / 重复抽象
- 推断每个文件**当前已 partial-split 程度** + 推荐拆分边界
- 对 Step 4.3 / 4.4 等 ≥ 1471 LOC 跨文件互依赖判定是否需走 full spike 走串行子 step
- 重构建议留 Phase 5.2（本 spike 仅 inform，不实施）

## 数据收集方法

13 文件 LOC + 内部结构 + 外向 import + 反向 caller 通过以下手段 grep 实测（commit 9a03b46）：

```bash
wc -l <file>                                                    # LOC 实测
grep -n "^import\| from '" <file>                                # import statement
grep -nE "^export|^class|^function|^  (async )?[a-z]" <file>     # 内部 export / class / function / method
grep -RIn "from ['\"]@main/<path>/<file>['\"]" src/                # caller 反查
```

## 13 文件 metrics 总表（commit 9a03b46）

| LOC | 文件 | export | 外向 import 数 | 反向 caller 数 | 当前 partial-split 程度 |
|---|---|---:|---:|---:|---|
| 1306 | hand-off-session.ts | 3 | 15 | 6 | 已抽 5 子模块（hand-off-session-impl + spawn + baton-cleanup + adopted-teams-context-block + helpers），**但 handler 函数体本身 1040 LOC inline** |
| 1281 | archive-plan-impl.ts | 12 | 11 | 10 (test heavy) | 已抽 `_shared/default-impl-deps` + `archive-plan/{precheck-helpers, index-sync-helpers}` 3 子模块，**但 impl 函数体本身 1025 LOC inline** |
| 874 | codex sdk-bridge/index.ts | 2 | 24 (10 internal) | (1 facade entry) | 已抽 11 子模块（constants/types/codex-binary/thread-loop/input-pack/session-finalize/restart-controller/thread-options-builder/create-session-rollback/resume-path-await/recoverer），**但 createSession 386 LOC inline** |
| 840 | claude sdk-bridge/index.ts | 2 | 27 (10 internal) | (1 facade entry) | 已抽 10 子模块（constants/types/permission-responder/can-use-tool/recoverer/stream-processor/restart-controller/pending-cancellation/mcp-server-init/query-options-builder/send-validation/session-finalize/sandbox-resolve/model-resolve），**但 createSession 357 LOC inline** |
| 721 | task-repo.ts | 8 | 3 (DB only) | 8 | 无子模块；createTaskRepo factory 388 LOC inline，type/interface 200+ LOC |
| 686 | session/manager.ts | 4 | 8 | **35** (项目核心 hub) | 已抽 4 helper 子模块（manager-helpers/enrich/team-coordinator/ingest-pipeline）；SessionManagerClass 606 LOC inline 含 ~17 method |
| 670 | claude sdk-bridge/recoverer.ts | 9 | 12 (5 internal) | (1 sdk-bridge index 主调) | 已抽 3 子模块（recoverer-helpers/recoverer-messages/jsonl-fallback）；SessionRecoverer 470 LOC inline + recoverAndSend 326 LOC |
| 623 | window.ts | 3 | 3 (electron only) | 3 (notify/visual + 2 ipc) | **无子模块**；FloatingWindow class 582 LOC inline 含 17 method |
| 597 | codex sdk-bridge/recoverer.ts | 8 | 11 (4 internal) | (1 sdk-bridge index 主调) | 已抽 2 子模块（codex-recoverer-messages/codex-jsonl-fallback）；SessionRecoverer 446 LOC inline + recoverAndSend 325 LOC |
| 594 | main/index.ts | 0 | 32 (相对 path 主) | (顶层 entry，0 caller) | **无子模块**；bootstrap async function 392 LOC inline，含 // 0 ~ // 9 注释 step 段 |
| 558 | adapters/types.ts | 8 | 3 (shared types only) | 8 | **纯 type declaration**；ClaudeCreateOpts / CodexCreateOpts / AdapterCapabilities / AgentAdapter 4 大 interface，jsdoc 注释占大头 |
| 544 | shared/types/settings.ts | 11 | 0 | 2 (shared/types.ts + shared/constants/read-only-tools.ts) | **纯 type declaration**；AppSettings interface 383 LOC + DEFAULT_SETTINGS + 9 PermissionScan related |
| 527 | agent-deck-message-repo.ts | 8 | 5 (2 internal) | 6 | 已抽 1 子模块（message-delivery-state）；createAgentDeckMessageRepo factory 281 LOC inline |

**合计**: 9821 LOC（与 plan D1 数据一致，13 文件无任何变化）。

## 关键发现

### F1 — 已 partial-split / 残留巨函数 vs 真原始巨型

**7 文件**（hand-off-session / archive-plan-impl / 双 sdk-bridge index / 双 recoverer / manager）**已经做了 partial split**（已抽 1-11 子模块），但 facade 文件仍超 500 LOC 的根本原因是**主 entry function/class 本身 inline 实现还很大**（300-1040 LOC range）。这意味着 Phase 4 mini-spike 的重点不是「子模块按功能领域分目录」（已经在做），而是：

- 拆 inline 大函数到独立子模块的 named function（典型 createSession / recoverAndSend / handOffSessionHandler / archivePlanImpl 把 inline phase 抽出来）
- facade 真正 thin 化（只 wiring + delegation，业务逻辑全进子模块）

**6 文件**（task-repo / window / main/index / adapters/types / shared/types/settings / agent-deck-message-repo 部分）属于**真原始巨型 / 纯类型 declaration**，inner-split 程度低，按 plan D5 facade pattern + 按 entity/method 域拆即可。

### F2 — 未发现 runtime circular dependency ✅

| 候选嫌疑 | grep 实测 | 结论 |
|---|---|---|
| manager.ts ↔ manager-{helpers,enrich,team-coordinator,ingest-pipeline} | manager-enrich 反向: 0 真 import (注释引用 sessionManager)；manager-ingest-pipeline 反向: 1 `import type { UpsertOptions } from './manager'` (**type-only**) | ✅ 无 runtime 循环 (type-only import 不构成运行时 import cycle) |
| session-repo / event-bus / settings-store 反向 import manager | grep 0 命中 | ✅ store 层不反向引用 manager |
| sdk-bridge index ↔ recoverer (双端) | 双端均 index → recoverer 单向，recoverer 不 import index | ✅ 单向，无循环 |
| 双 sdk-bridge 端 (claude/codex) 互引用 | grep 0 命中 | ✅ adapter 隔离正确 |
| adapters/types.ts 反向被 sdk-bridge index 引用 | sdk-bridge 各自有自己 sub-`./types`（claude `./types`, codex `./types`），**与 adapters/types.ts 不是同一文件**；adapters/types.ts 仅被 adapter 入口 ipc 等 8 caller import (上层引用，正确) | ✅ 无双向 |

### F3 — 重复抽象嫌疑 (mcp handlers shotgun-import) ❓ nice-to-have

15 个 mcp handler 文件普遍 import 同一组依赖：

| handler | sessionManager | sessionRepo | agentDeckTeamRepo | eventBus |
|---|:---:|:---:|:---:|:---:|
| archive-plan | 0 | 1 | 0 | 0 |
| baton-cleanup | 1 | 1 | 0 | 2 |
| enter-worktree | 0 | 1 | 0 | 0 |
| exit-worktree | 0 | 1 | 0 | 0 |
| get | 1 | 0 | 0 | 0 |
| hand-off-session | 2 | 1 | 1 | 1 |
| list | 1 | 1 | 0 | 0 |
| send | 0 | 1 | 1 | 0 |
| shutdown-teammates-on-baton | 1 | 0 | 1 | 0 |
| shutdown | 1 | 1 | 0 | 0 |
| spawn | 1 | 1 | 1 | 1 |
| task-create / task-update / task-delete / task-helpers | 各种部分组合 | | | |

**建议**: 可抽 `_shared/mcp-handler-deps.ts` 提供「default handler deps bundle」（facade pattern）让 handler 只 import 需要 namespace，降低 shotgun-import noise。但**非本 plan scope**（13 大文件 D1 list 不含 handlers / 子 handler 文件 LOC 都 < 500）→ Phase 5.1 D 维 review 可以提议，作为 follow-up plan candidate。

### F4 — main/index.ts bootstrap god-function (392 LOC inline) ❌ 必拆

bootstrap async function 392 LOC inline 含 // 0 ~ // 9 + // 5.1 // 5.1.1 // 5.5 // 7.0 // 7.05 // 8.5 // 8.6 多 step 注释。**典型 god-function**，难调试、难单测、改一个 step 撞 392 行 diff。

**推荐拆分**（Step 4.8）：按 // step 注释的天然边界抽 named function（如 `bootstrapDatabase()` / `registerAdapters()` / `initLifecycleSchedulers()` / `wireMcpServer()` / `installCodexConfig()` / `initWindow()` / etc.），index.ts facade 保留 top-level statement + bootstrap 入口调度。

### F5 — task-repo / agent-deck-message-repo factory pattern 拆分阻力低 ✅

两 repo 同款 factory + singleton wrapper 模式：

```ts
export interface XxxRepo { create(...); get(...); list(...); ... }
export function createXxxRepo(db: Database): XxxRepo { ... }  // factory 内含所有 CRUD
const _defaultRepo: XxxRepo | null;
function defaultRepo(): XxxRepo { return _defaultRepo ??= createXxxRepo(getDb()); }
export const xxxRepo: XxxRepo = { ... };  // singleton wrapper delegate 到 _defaultRepo
```

interface 定义 / factory 内的 method body 都可抽到子文件，原文件改 facade re-export：

- task-repo.ts (721 LOC) → `task-repo/{types, factory-crud, factory-scope, factory-list, factory-cleanup}.ts` + `task-repo.ts` facade
- agent-deck-message-repo.ts (527 LOC) → `agent-deck-message-repo/{types, factory-crud, factory-lifecycle}.ts` + facade

### F6 — adapters/types.ts + shared/types/settings.ts 纯类型 declaration ✅

8 + 11 个 export interface，**runtime 0 行 code**，全是 type alias / interface + jsdoc。Plan D1 强制全拆 ≤ 500 LOC，拆法：

- adapters/types.ts (558) → `adapters/types/{adapter-context, claude-create-opts, codex-create-opts, permission-mode, adapter-capabilities, agent-adapter}.ts` + `adapters/types.ts` facade re-export
- shared/types/settings.ts (544) → `shared/types/settings/{app-settings, defaults, hook-install, settings-source, permission-scan}.ts` + `shared/types/settings.ts` facade re-export

**注意**: jsdoc 仍占大头不会因拆分缩小。**但 LOC ≤ 500 facade 文件 + 各 subfile ≤ 200 LOC 都满足拆分原则**。如某 subfile（如 app-settings.ts 含 AppSettings interface jsdoc）超 500，再二次拆 settings sub-domain（如 `app-settings/{audio, notification, summary, hand-off, agent-deck-mcp, ...}.ts`）。

### F7 — Step 4.3 / 4.4 双 sdk-bridge index + recoverer 跨文件互依赖性质 ⚠️ 介于 mini-spike 与 full spike 之间

plan §D2 + Phase 4 Step 4.3/4.4 描述「跨文件互依赖 full spike 必跑（≥ 30min 深入分析）或按依赖顺序拆 4.3a/4.3b 串行」。**spike 实测**：

- claude sdk-bridge：index → recoverer 单向 import（line 46 `import { SessionRecoverer, defaultResumeJsonlExists, defaultCwdExists } from './recoverer'`）
- codex sdk-bridge：index → recoverer 单向 import（line 45 同款）
- 双端 recoverer 都不反向 import index

**结论**: **互依赖只是单向**，不是真正双向耦合。**推荐路径**：

- Step 4.3 / 4.4 不需走 full spike（≥ 30min 深度分析）—— mini-spike + user confirm 即可
- 但仍建议**按依赖顺序拆**（先 recoverer 再 index）：因为 recoverer 拆完得到 stable surface area + recoverAndSend phase 边界后，index 拆 createSession 可以参考同款 phase 划法
- 拆完 recoverer 单独 commit + typecheck，再拆 index → typecheck，phase 收口前 squash

**改动半径估算**：
- Step 4.3 (codex sdk-bridge + recoverer)：874 + 597 = 1471 LOC → 拆后估算 facade index ~150 / recoverer ~150 + 4-6 子文件 each
- Step 4.4 (claude sdk-bridge + recoverer)：840 + 670 = 1510 LOC → 同款估算

### F8 — manager.ts hub 影响面广，facade 重构必保 35 caller 不变 ⚠️

session/manager.ts 是项目**第一大 hub**（35 caller，超 mcp tools 8 caller 4 倍）。任何 facade 重构必须严格 re-export 兼容（不改 `sessionManager` singleton public method signature）。

**推荐拆分**（Step 4.6）：sessionManager class 17 method 按域分（sdk-claim / lifecycle / rename / team / list 5 域）抽 named function 到子文件，class 内 method body delegate 到 named function。facade re-export `sessionManager` singleton 形状 byte-identical。

**风险**: ECMAScript private `#sdkOwned` field 仅在 class 内访问，拆出去的 named function 通过 SessionManagerClass instance method 链路调，**不能**直接 take `#sdkOwned` 作 closure access。需要保留 manager.ts 内 class 内部 sdk-claim 几个方法 inline，其他 method 走 delegation 到 named function。

### F9 — window.ts FloatingWindow 17 method 真原始巨型 ✅ method 域拆即可

FloatingWindow class 582 LOC inline 含 17 method（create / setAlwaysOnTop / toggleCompact / toggleMaximize / toggleDefault / setIgnoreMouse / flash / close / 等）。**0 子模块**（早期 P1 设计就单文件）。

**推荐拆分**（Step 4.7）按 method 域分（frame / interaction / lifecycle / facade）抽 named function，class 内 method body delegate。

## 推荐拆分边界总表（per Step）

| Step | 文件 | LOC | 推荐子模块边界 | 难度 | mini-spike 充足 / full spike 需 |
|---|---|---:|---|---|---|
| 4.1 | hand-off-session.ts | 1306 | facade + plan-mode-handler/generic-mode-handler/task-reassign-coordinator/team-adopt-coordinator/cwd-resolver-helpers 5 子模块（基于 handler 内 inline phase 分支） | 高（handler 1040 LOC 巨函数 + 多 phase 顺序硬约束） | mini-spike 充足，但 Step 4.x.0 user confirm 时多花 5min 同步 phase 顺序约束 |
| 4.2 | archive-plan-impl.ts | 1281 | facade + 4 phase + spike-reports-archive + commit-flow（基于 impl 内 inline phase 分支 + 已有 archive-plan/ 子目录扩展） | 高（同上 1025 LOC 巨函数） | mini-spike 充足 |
| 4.3 | codex sdk-bridge/index.ts + recoverer.ts | 874+597=1471 | **按依赖顺序拆 4.3a recoverer→4.3b index 串行**；recoverer 拆 recoverAndSend phase / restart-coordinator；index 拆 createSession phase / sendMessage / closeSession-cleanup | 高 | mini-spike 充足（单向依赖确认） |
| 4.4 | claude sdk-bridge/index.ts + recoverer.ts | 840+670=1510 | 同 4.3 对称结构 | 高 | mini-spike 充足 |
| 4.5 | task-repo.ts | 721 | facade + types + factory-crud + factory-scope + factory-list + factory-cleanup 5 子模块 | 中（factory pattern 显然分） | mini-spike 充足 |
| 4.6 | session/manager.ts | 686 | facade + sdk-claim (含 #sdkOwned 内部访问) + lifecycle + rename + team + list 5 域 | 中（35 caller hub 需保 byte-identical singleton；#sdkOwned 私有访问限制） | mini-spike 充足 + user confirm 时多花 5min 同步 35 caller 不变约束 |
| 4.7 | window.ts | 623 | facade + frame + interaction + lifecycle 4 域（按 method 分组） | 低（纯 class method 域分） | mini-spike 充足 |
| 4.8 | main/index.ts | 594 | facade + bootstrap-orchestrator + bootstrap-{database, adapters, lifecycle-schedulers, ipc, mcp-server, codex-config, window, watchers} 多 step | 中（392 LOC bootstrap god-function 按 // step 注释天然边界） | mini-spike 充足 |
| 4.9 | adapters/types.ts | 558 | facade + adapter-context + claude-create-opts + codex-create-opts + permission-mode + adapter-capabilities + agent-adapter 6 子文件（按 export interface 分） | 低（纯类型 declaration） | mini-spike 充足 |
| 4.10 | shared/types/settings.ts | 544 | facade + app-settings + defaults + hook-install + settings-source + permission-scan 5 子文件 | 低（纯类型 declaration） | mini-spike 充足 |
| 4.11 | agent-deck-message-repo.ts | 527 | facade + types + factory-crud + factory-lifecycle 3 子文件 | 低（同 task-repo factory pattern） | mini-spike 充足 |

## 跨文件 / 架构层 review（inform Phase 5.1 D 维 report）

### A1 — handler shotgun-import → `_shared/mcp-handler-deps.ts` 重复抽象嫌疑（详 F3）

**Phase 5.1 候选 finding（MED）**：mcp handlers 普遍 import 同 4 个依赖（sessionManager + sessionRepo + agentDeckTeamRepo + eventBus），但**已超本 plan D1 13 文件 scope**（handler 文件单文件都 < 500 LOC），建议作为 follow-up plan candidate。

### A2 — manager.ts hub 35 caller 是否过分耦合 ❓ 待 Phase 5.1 review

35 caller 反向引用 session/manager 在大型 desktop app 是否合理？候选 review 角度：

- ipc handlers + mcp handlers + adapter sdk-bridge 都需要 sessionManager —— 是合理 hub 因为所有「记录会话状态」都得过 sessionManager
- 反过来如果 sessionManager 被拆成多个子 service（如 SessionStore / SessionLifecycleService / SessionTeamCoordinator）caller 也得 import 多个 service，**收益不明显**
- **建议**: Phase 5.1 D 维 review 标记「考察 35 caller 是否都真正需要 sessionManager full API，是否能下沉到子 namespace」作 LOW finding，不强求 follow-up plan

### A3 — 双 sdk-bridge claude/codex 结构对偶但不抽象基类 ✅ 合理（保留）

两 sdk-bridge index + recoverer 镜像对偶但 0 抽象基类（不共享 ClaudeSdkBridge / CodexSdkBridge 父类）。**合理 design**：

- 两个 SDK 协议差异大（claude streaming input → SDKMessage；codex thread.run → ThreadEvent）
- 抽象基类会让 mock interface 大于实质共享 code，net negative
- 通过 `_shared/find-fallback-cwd.ts` 抽共享 helper（cross-adapter）已经够用

**结论**: 保留双 bridge 独立实现 + cross-adapter `_shared/` 抽 helper 的现状，**不**升级到抽象基类。

### A4 — types/setttings 的 enrichment 走 enrich helper 不放在主 type 文件 ✅ 合理（保留）

session-repo / sessionRecord enrichment 走 manager-enrich.ts 而非 session/manager.ts 内 method body，**合理 design**（避免 sessionRepo / agent-deck-team-repo 跨表 join 逻辑混入主 facade）。

## 已知 risk / 残留风险

1. **mini-spike user confirm 仍需仔细把 phase 顺序硬约束传给 user**：Step 4.1 / 4.2 的 handler / impl 主函数内多 phase 注释「N 段顺序硬约束」，拆分后子函数命名 + 顺序必须保 order。Step 4.x.0 user confirm 时 1-min 同步够。
2. **Step 4.6 manager.ts #sdkOwned 真私有不能拆出 class**：拆方案需保留 sdk-claim 几个 method 在 class 内 inline（不下沉到 named function），其他 method 可下沉。
3. **Step 4.8 main/index.ts bootstrap 拆出 named function 需保异步顺序**：`await initDb` 必须先于 `adapterRegistry.initAll` 必须先于 `setSessionCloseFn` 等。命名后 bootstrap facade 改为 sequence `await bootstrapDatabase(); await registerAdapters(); await wireMcpServer(); ...` 的 orchestrator 模式。
4. **Step 4.9 / 4.10 纯类型拆分 jsdoc 仍占大头**：拆完后 subfile 仍可能 200-400 LOC（如 app-settings.ts 含 AppSettings 巨型 interface jsdoc）。可接受（facade ≤ 500 LOC 满足约束，subfile 自有 jsdoc 不强求 < 500）。
5. **Step 4.12 phase 收口前 `pnpm typecheck + build + dist` 必跑**（plan §已知踩坑 拆分必跑 typecheck/build/dist + P26 教训）。
6. **测试不动**：D5 规定测试默认不拆。但 Step 4.1 / 4.2 拆出 named function 后 test 路径 import 也需要跟随更新（test 文件本身不拆，但 import path 可能要改）。

## Phase 5.1 D 维 review candidate（inform 后续 report）

基于本 spike，给 Phase 5.1 D 维 review 报告的 candidate finding list（**不**实施，仅记录）：

| 级别 | candidate finding | 来源 |
|---|---|---|
| INFO | 双 sdk-bridge 对偶不抽基类，合理保留 | F2 + A3 |
| INFO | 双 sdk-bridge index + recoverer 单向依赖，互依赖判定为「mini-spike 充足」非 full spike | F7 |
| LOW | manager.ts 35 caller hub，考察是否能下沉到子 namespace（收益不明显，建议保留） | F8 + A2 |
| LOW | mcp handlers shotgun-import session/manager + sessionRepo + agentDeckTeamRepo + eventBus，可抽 `_shared/mcp-handler-deps.ts` bundle facade（**超本 plan scope** → follow-up plan candidate） | F3 + A1 |
| MED | main/index.ts bootstrap 392 LOC god-function — Step 4.8 拆名 function (本 plan 内修) | F4 |
| HIGH | manager.ts SessionManagerClass 606 LOC + 17 method — Step 4.6 facade + 5 域拆 (本 plan 内修) | F8 |
| HIGH | hand-off-session.ts handOffSessionHandler 1040 LOC inline + archive-plan-impl.ts archivePlanImpl 1025 LOC inline — Step 4.1/4.2 拆 phase 子模块 (本 plan 内修) | F1 |
| HIGH | claude / codex sdk-bridge createSession 357/386 LOC inline — Step 4.3/4.4 拆 phase 子模块 (本 plan 内修) | F1 |
| HIGH | claude / codex sdk-bridge recoverer recoverAndSend 326/325 LOC inline — Step 4.3/4.4 拆 phase 子模块 (本 plan 内修) | F1 |

**HIGH 7 条全在 Phase 4 内**修（本 plan scope），D 维 review 报告主要是 LOW / INFO + 总结架构合理性结论。

## 结论 / Phase 4 推荐节奏

1. **拆分顺序优化**：D1 表是按 LOC 降序排（hand-off-session 第一），但实际从 ROI 看推荐顺序：
   - **先低风险 / 纯结构拆**（Step 4.9 / 4.10 / 4.7 / 4.11 / 4.5 / 4.8）：纯类型 / window / repo / bootstrap，无 multi-phase 顺序硬约束，rookie-friendly
   - **再 hub 级**（Step 4.6 manager 35 caller）：facade re-export 保 byte-identical
   - **最后大 handler / sdk-bridge**（Step 4.1 / 4.2 / 4.3 / 4.4）：1000+ LOC 巨函数 multi-phase 顺序硬约束 + 跨文件互依赖
   - 让前面拆分形成的子模块 layout 经验 inform 后面更复杂 step
2. **mini-spike 充足 vs full spike 必跑**：spike 实测**所有 Step 4.x 都走 mini-spike 充足**（Step 4.3/4.4 互依赖只是单向，不真双向）。但建议 Step 4.6 / 4.8 / 4.1 / 4.2 mini-spike 时 user confirm 多花 5min 同步 multi-phase 顺序硬约束。
3. **Step 4.0 read-only spike 收口**：本 spike 完成 → Step 4.x.0 mini-spike 起用本 spike 推荐边界作 default proposal → user 1-min confirm 后实施。

---

**spike 完成时间**: 2026-05-29 11:08+08:00
**总耗时**: ~1.5h（grep + 数据分析 + 写 spike md）
**read-only commit/edit 次数**: 0 (仅 Bash grep / wc / sed / Read)
**worktree status**: clean（spike md 在 plan artifact dir 外置，**不入 worktree commit**，详 plan §当前进度 Phase 3 Step 3.1 同款约定）
