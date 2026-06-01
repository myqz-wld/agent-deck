# REVIEW_97 — SQLite 单测「真跑不 skip」+ 修 4 失败文件

> 关联 plan：`ref/plans/sqlite-tests-no-skip-20260601.md`
> 性质：测试基础设施加固（debug/test-infra，归 reviews 非 changelogs —— 无生产功能变更）
> 经 Step 1.5 deep-review（reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5 异构对抗，0 HIGH）

## 背景与诉求

用户要求「所有单元测试真跑通，不要 skip」。基线 `pnpm test`（系统 node v24 / ABI 137）下：
- better-sqlite3 装的是 Electron 33 的 **ABI v130** binding（app 实际 runtime）
- vitest 跑在系统 node（ABI 137）→ 加载 ABI-130 binding 失败 → 12 个 SQLite 单测文件 `describe.skipIf(!bindingAvailable)` 全 skip（200 用例）+ 16 个环境 gate skip = **216 skip**
- 另有 4 个 test 文件存在 ABI 无关的真 bug（即使 binding 能加载也挂）

这是 BY DESIGN 的取舍（CHANGELOG_42：prebuild-install rebuild 会覆盖 Electron binding 导致 app bootstrap 挂 → 选择默认 skip）。本次推翻该 design。

## 方案 A：`pnpm test` 默认走 Electron-as-node（零 binding swap）

**核心**：用 Electron 内置 node（v20.18.3 / **ABI 130**，正好匹配现装 binding）跑 vitest：
```
ELECTRON_RUN_AS_NODE=1 <electron 二进制> node_modules/vitest/vitest.mjs run ...
```
→ **零 binding swap、零 corruption**（全程不碰 `build/Release/better_sqlite3.node`）。

**方案 B 否决**（spike 实证）：better-sqlite3@11.10.0 `lib/database.js:48` 用 `require('bindings')('better_sqlite3.node')` → `bindings` 包只认 `build/Release/` 单槽，**不扫 `prebuilds/` 多 ABI 目录**。populate prebuilds/ 无效。

**ABI 物理约束**（实测）：130 是 Electron 33 专属，无任何 stock node 命中（node18=108/20=115/22=127/23=131/24=137）。native addon 一份 binding 物理上不可能同时被系统 node 和 Electron 加载 —— 这是固有约束，非配置问题。故保留系统 node 变体 `pnpm test:node` 作安全网（SQLite 真测优雅 skip + loud error 指路），不追求「彻底消除 ABI 不匹配」（业界 Electron 应用通行做法）。

## 改动清单（14 文件：11 改 + 3 新增；**0 生产 .ts 改动**，不变量 2 守住）

### 测试基础设施
- **新增 `scripts/test-electron.mjs`**：Electron-as-node vitest wrapper。`createRequire(import.meta.url)` + `require('electron')` 拿二进制路径；`stdio:'inherit'`（防 ENOBUFS + 终端哑巴）+ `process.exit(res.status ?? 1)`（防假绿退出码）+ `res.error` 兜底（spawn 自身失败）+ `cwd` 固定 repo root。
- **`package.json`**：`test`→`node scripts/test-electron.mjs`（Electron-as-node，0 binding-skip）；新增 `test:node`→`vitest run`（系统 node 快速变体，SQLite 优雅 skip）。
- **新增 `src/main/store/__tests__/_binding-probe.ts`**：probe SSOT，收敛原散落 6 处的 `probeBetterSqliteBinding`（2 _setup + 4 inline）。probe 失败时 `console.error`（loud，非 warn）提示「用错 runtime，请跑 pnpm test」。
- **6 处 probe 收敛**：4 inline（v023/v024/v025-migration + repo-tiebreaker，本地 const）直接 import；2 _setup（agent-deck-repos + session-repo）**import + re-export**（兜 8 个下游 consumer 的 `import { bindingAvailable } from './_setup'` 0 改动）。

### 4 个真失败 test 文件修复（全 test-side，生产代码正确）
- **cwd-release-marker.test.ts（4 fail→pass）**：根因 = session-repo `_setup.ts` 只载 v001-v020，但 `core-crud.upsert` 写 `cli_session_id`(v021) / `rename.ts` 迁 `tasks.owner_session_id`(v023) → `no such column`。修法：补 v021-v026 对齐 agent-deck-repos/_setup。**+ 顺手修 TC2b 边角 stale 断言**（spike 阶段被 `no such column` crash 遮蔽）：老断言期望「OLD null 不覆盖 NEW marker」，但生产 `rename.ts:283` 已改无条件覆盖（P5 reviewer-codex MED-2，marker 是 transient session state，rename=OLD 接管 NEW 身份）→ 改断言为 NEW 被清空 null。
- **task-repo.test.ts（2 fail→pass）**：根因 = test spy `console.warn`，但代码 `_deps.ts:53/56` 用 `logger.warn`（354 console→logger 迁移后留下的 stale 断言）。修法：改 spy `log.scope('task-repo-deps').warn`（vitest-setup 已 mock 成 vi.fn；scope name 必须精确一致防假绿），保留「损坏数据要 warn」契约验证。
- **v023-migration.test.ts（1 fail→pass）**：根因 = test 期望重跑 v023 抛 `/already exists/`，但 SQL 开头 `DROP TABLE IF EXISTS tasks` → 重跑永不抛。修法：改断言为 destructive DROP+CREATE 契约（插一条 → 重跑不抛 → 显式断言被清空 + schema 正确）。
- **codex-binary-layout.test.ts（suite fail→15 pass，仅 Electron-as-node 下暴露）**：根因 = `beforeAll` 直接赋值 `process.resourcesPath`，但 Electron 把该属性设为 read-only（`writable:false, configurable:true`）→ `TypeError`。修法：改 `Object.defineProperty(process, 'resourcesPath', {configurable:true, writable:true})`（两 runtime 都 work）。

### un-skip + 补测盲区
- **hand-off-session.impl-core.test.ts（1 it.skip→真跑）**：REVIEW_56 把 `handOffSessionImpl` 从 hard-reject 改为返结构化 `worktreeExists` flag，老 test 仍按 hard-reject 写。重写断言当前契约（resolved + `worktreeExists===false`）。
- **新增 hand-off-session.cwd-resolver-worktree.test.ts（D8b / codex MED-2 补测盲区）**：deep-review 发现 handler 层 `validatePlanModeWorktreeExists`（cwd-resolver.ts:184）的 worktree-missing 4-case 决策树**无任何专属 test**。新增 7 case 纯函数单测（worktreeExists=true 放行 / generic 放行 / 约定 worktree+finalCwd=mainRepo 放行 / finalCwd=worktreePath reject / 外置 worktree reject / finalCwd 在 mainRepo 外 reject）。

## Deep-Review 收口（Step 1.5）

reviewer-claude + reviewer-codex 异构对抗 R1，**双方 0 HIGH**，独立实地核验 4+1 根因诊断全部准确、「生产代码不动」成立。5 条 MED/LOW 全部采纳补进 plan/实现：
- **wrapper stdio/exit 契约**（双方独立提出 ✅ 必修）
- **D3 re-export + 8 consumer**（claude MED-1，typecheck 验证）
- **D8b cwd-resolver 决策树补测**（codex MED-2，现场验证函数存在）
- **§下一会话第一步 adapter-safe**（codex MED-3）
- **v023 表述精确化 / 不变量5 darwin-arm64 限定 / D5 收敛 log.scope spy**（LOW/INFO）

## 验证结果

| 检查项 | 结果 |
|---|---|
| `pnpm test`（Electron-as-node，目标命令） | ✅ **1514 passed / 0 failed / 0 skipped**（111 files，exit 0） |
| `pnpm typecheck`（双配置） | ✅ 绿（re-export 接线正确，8 consumer 全解析） |
| 🔴 binding md5 | ✅ 全程恒 `64beb2ef045af83e20a5294908f30f70`（红线守住，零 swap） |
| `pnpm test:node`（系统 node 安全网） | ✅ 1299 pass / 215 graceful skip + loud error（按设计降级） |
| 真 Electron 加载 ABI-130 binding | ✅ load OK（app bootstrap 路径无 NODE_MODULE_VERSION） |
| 不变量 2「生产代码不动」 | ✅ 14 文件全 `__tests__/` + test-infra + package.json + scripts，0 生产 .ts |

## 残留 / 已知边界（非缺陷）

- **`pnpm test:node` 215 skip 是设计安全网**：ABI 不匹配是 Electron native addon 物理固有约束（用户拍板保持现状）。用错 runtime 时优雅降级 + loud error 指路，而非整套 crash。
- **codex-binary-layout 15 个 `it.runIf(isDarwinArm64)` 跨平台门控**：非 darwin-arm64（Linux/x64 CI）按平台 skip，与 binding 无关。本机 darwin-arm64 上 0 skip。
- **无 CI**（`.github/workflows/` 不存在）：0 skip/0 fail 靠 `pnpm test` 人工跑保障；wrapper 退出码透传为未来 CI 接入预留正确语义。
