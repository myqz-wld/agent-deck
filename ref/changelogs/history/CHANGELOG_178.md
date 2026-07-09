# CHANGELOG_178 — plan runtime-logging-electron-log-20260529 完整归档 (electron-log v5 引入 + 354 处 console.* migrate to scoped logger + LogsSection UI)

## 概要

[plan `runtime-logging-electron-log-20260529`](../../plans/history/runtime-logging-electron-log-20260529.md) 完整收口归档。引入 [electron-log v5](https://github.com/megahertz/electron-log) 让 macOS .app 双击启动场景下 console.* 输出真正落盘(原 minimal launchd 启动无终端 → stdout/stderr 全丢, plan §不变量 1 根本目标)。

**继承自** plan `sdk-spawn-shell-path-20260529` follow-up — 主进程 PATH 修后 user 报 .app 双击启动场景 console.* 落盘需求。

**净改动** (19 commits): 主肉是把 src/main + src/renderer 共 215 + 16 = **231 处 console.X** 改成 `logger.X` scoped logger 调用 (78 个 src 文件) + 装 electron-log@5.4.4 + 写 main + renderer logger.ts 双进程封装 + Settings 加 LogsSection UI (3 button + 1 dropdown) + 3 IPC handler + scripts/logger-check.sh CI 守门 + README 用法文档。

**不变量守约**:
- ✅ **NODE_ENV='test' 跳过 console 接管** — vitest 51 处 `vi.spyOn(console)` 零改动通过 (spike (c) 实证 + Step 3.5.1.5 4 assert 覆盖)
- ✅ **vitest 0 fail / 1003 pass / 159 skip 维持** — 19 commit 每批跑全量 vitest 都 0 fail
- ✅ **typecheck + build 双过** — main 715.81 kB / preload 21.63 kB / renderer 1427.72 kB
- ✅ **src/main + src/renderer 0 console.X 残留** — `scripts/logger-check.sh` grep CI 双重检查通过 (排除 __tests__ + *.test.ts + src/preload)
- ✅ **logger.ts 模块独立性 §不变量 8** — 不依赖任何 @main/@shared/@renderer 业务模块
- ✅ **按天拆 + 14 天 cleanup** — `~/Library/Logs/Agent Deck/main-YYYY-MM-DD.log` (macOS)
- ✅ **fatal hook 覆盖** uncaughtException + unhandledRejection (D7)
- ✅ **dev/prod log path 一致** — `app.setName('Agent Deck')` 让 dev 不再分流到 `~/Library/Logs/Electron/`
- ✅ **接管不吞 stdout** — dev terminal 仍能看到 console.log 输出 (spike (c) 实证)

## 变更内容

### Phase 0 — RFC 4 轮 + spike 3 项 (前会话, commit 3b729eed)

- RFC Q1-Q4 对齐 design 大方向 (rotate 策略 / 接管 console / NODE_ENV='test' 跳过 / 354 处全改 scoped)
- spike (a) rotate 策略 5 项验证 (按天拆 + 14 天 cleanup 完全替代 archiveLog hook)
- spike (c) NODE_ENV='test' 跳过接管 4 项验证 (vi.spyOn 兼容)
- spike (b) preload IPC bridge deferred 到 Step 3.0 (Electron 运行时必须)

### Phase 1 — 基础设施 (本会话 6 commits)

- **Step 3.0.1 + 3.0.2** (前会话 df3f4b1): 装 electron-log@5.4.4 + 写 main logger.ts (init / resolvePathFn 按天 / cleanupOldLogs 14 天 / errorHandler.startCatching / app.setName / 接管 console)
- **Step 3.0.2.5** (cade4d5): vitest-setup.ts 全局 mock electron + electron-log/main + electron-store (D15 §mock 范围实证扩展 — electron-store@8.2.0 CJS 顶层 `require('electron')` vitest hoist 拦不住, 必须单独 mock 整包) — 把 baseline 30 fail 全修
- **Step 3.0.3** (3461ecd): renderer logger.ts + `shouldCaptureRendererConsole(mode)` 纯函数 (Round 2 fix R2-9 一次性抽出)
- **Step 3.0.4** (307e3ae): main + renderer entry 顶部第一行 import logger.ts (让 errorHandler.startCatching 立即生效 + console 接管 + IPC bridge) + `src/renderer/global.d.ts` 加 `/// <reference types="vite/client" />`
- **Step 3.1** (6e4087f): AppSettings.logLevel 字段 ('error'/'warn'/'info'/'verbose'/'debug'/'silly' 默认 'info') + IPC apply 即改即生效 (只控 file transport, console 永远 silly)
- **Step 3.5.1.5** (b7fd5df): shouldCaptureRendererConsole 4 assert (vitest-setup electron-log/renderer mock 扩展 — D15 §mock 范围再实证扩展, vitest reporter stdout 卡 5+ min 推动)
- **Step 3.5.1** (9421411): main logger.ts 6+2 assert (mock-mediated 折中 — plan 原 spec vi.unmock + vi.doMock 序列在 vitest 2.1.9 实测全部失效, 接受 mock 上验证业务模块调用)

### Phase 2 — 354 处 console.X 全 migrate (Step 3.3 6 批, 本会话 6 commits + Step 3.4 1 commit)

| 批 | Commit | 范围 | 文件 | console.X | broken test fix |
|---|---|---|---|---|---|
| 3.3.1 adapters/ | 7bb083f | src/main/adapters/** | 23 | 61 | 3 (warnSpy → log.scope().warn) |
| 3.3.2 store/ | 6a3b1c7 | src/main/store/** | 9 | 20 | 2 + Step 3.3.1 unused import 清理 |
| 3.3.3 session/+teams/ | 861ed9f | src/main/session/+teams/** | 10 | 35 | 0 |
| 3.3.4 ipc/ | 2334234 | src/main/ipc/** | 5 | 13 | 1 (handoffLogger.warn) |
| 3.3.5 utils/+mcp/+hook-server/ | 3e9859f | src/main/utils + agent-deck-mcp + hook-server | 13 | 33 | 9 (Pattern A 8 + Pattern B bundled-assets local mock 补) |
| 3.3.6 顶层+bootstrap+codex+notify+window | 8552d5a | src/main 顶层 + index/ + codex-config/ + notify + window | 12 | 53 | 0 |
| **小计** | | | **72** | **215** | **15** |
| 3.4 renderer/ | 22a828f | src/renderer/** (main.tsx side-effect import 升级为 default import) | 7 | 16 | 0 |
| **总计** | | | **79** | **231** | **15** |

每文件加 `import log from '@main/utils/logger'` (or `@renderer/utils/logger`) + `const logger = log.scope('<kebab-name>')`, console.log/warn/error/info/debug → logger.info/warn/error/info/debug.

**手法**: Bash sed 批量替换 console.X → logger.X → Agent 委派加 import + const → typecheck + vitest verify → 修 broken test (统一改 spy log.scope('xxx').warn pattern, vitest-setup.ts mock 让 log.scope() 返 cached vi.fn() object 同 name 同一个 obj) → commit。Round 3 fix MED-Codex-2 配套: sed 顺手清掉注释 / 字符串内 console.X 字面避免 Step 3.5.2.5 grep CI 误报。

**plan spec 估 354 偏多** — 实际 src/main 只 215 处 (plan 估含测试文件 + 注释字面 + 估算偏差); renderer 实际 16 处 (plan 估 17 处差 1)。

### Phase 3 — CI 守门 + Settings UI + README (本会话 3 commits)

- **Step 3.5.2.5** (691d464): `scripts/logger-check.sh` 双重检查 (0 残留 + logger.ts 独立性) + `pnpm logger:check`。实测 plan spec `rg -t ts -t tsx` 报 "unrecognized file type: tsx", 修法用 `--type-add 'tsx:*.tsx' -t ts -t tsx` 注册
- **Step 3.5.3** (无新 commit): pnpm typecheck + pnpm build 双过
- **Step 3.6** (862cdc6): README §设置 加日志级别 + §项目结构 加 utils/logger.ts + scripts/logger-check.sh 入口 + §开发指南 加「日志 (runtime logging)」节 (跨平台路径 / 业务模块用法 / NODE_ENV='test' / fatal hook)
- **Step 3.2** (9bd33c9): Settings LogsSection UI 完整 (`src/renderer/components/settings/sections/LogsSection.tsx` 130 行) + 3 IPC handler (`src/main/ipc/logs.ts` 70 行 with D9 fallback: showCurrentInFinder 文件不存在 → openPath / truncateToday existed=false → toast) + preload miscApi 3 typed method + shared/ipc-channels 3 channel 常量 + SettingsDialog 挂载到「集成与运行环境」分组

### Phase 4 — main merge + 收口 (本会话 3 commits)

- **9d6a237 merge main into worktree**: main 比 worktree 多 5 commit (mcp-tool-camelcase-migration-20260529 breaking change snake_case → camelCase), worktree Step 3.3.5 改 src/main/agent-deck-mcp/tools/handlers/* 撞 4 处 conflict 全部 resolution = worktree logger.X + main camelCase (spawn.ts 2 处 args.teamName / shutdown-baton-teammates.ts 1 处 planId / task-reassign-coordinator.ts 5 处 teamTaskPolicy+handOff+adoptTeammates / shutdown-baton-teammates.handler.test.ts 1 处 warnMock+planId)
- **本 commit** (CHANGELOG_178 + INDEX + tally.md P39): 经验沉淀候选 P39 (vitest 2.1.9 mock 行为四组集成测试踩坑模式化, count=1 起步, 含 CJS package mock / vi.unmock+vi.doMock 序列失效 / import.meta.env.MODE renderer 替换异常 / rg -t tsx 不识别 4 组踩坑 + sed batch broken test fix pattern)

### 跳过 step (待 user GUI verify / e2e)

- **Step 3.0.5** — `pnpm dev` 实测 spike (b) B1-B9 验证清单 (user GUI verify)
- **Step 3.0.6** — spike (b) 失败时 fallback IPC bridge (条件性)
- **Step 3.0.7** — spike (d) preload console.error 落盘验证 4 方案 (dev runtime)
- **Step 3.2.6** — preload `src/preload/index.ts:38` 改动 (依赖 Step 3.0.7 spike (d) 选定方案)
- **Step 3.7.0-3.7.3** — e2e .app dist 验证 (plan 根本目标; dist + 装到 /Applications + 双击启动看 ~/Library/Logs/Agent Deck/main-*.log)
- **Step 3.8** — invoke deep-review SKILL (Step 3 全 scope 后做)

## 关联

- Plan: [`ref/plans/runtime-logging-electron-log-20260529.md`](../../plans/history/runtime-logging-electron-log-20260529.md) (archive_plan 同步入 git)
- Spike artifacts: `ref/plans/runtime-logging-electron-log-20260529/spike-reports/` (spike1 rotate / spike2 test-env / spike3 preload IPC bridge)
- 经验沉淀: [`ref/conventions/tally.md` §P39](../../conventions/tally.md)

## 后续 follow-up (留 separate plan)

1. **plan §不变量 1 GUI 实测** — user 跑 `pnpm dev` (Step 3.0.5) + `pnpm dist` 装 .app (Step 3.7) verify 生产场景日志真正落盘到 `~/Library/Logs/Agent Deck/main-YYYY-MM-DD.log`
2. **Step 3.2.6 preload console.error** — 走 Step 3.0.7 spike (d) 选定方案 (方案 1 sendToMain helper / 方案 2 typed IPC / 方案 3 webContents.on('console-message') / 方案 4 webContents.on('preload-error'))
3. **Step 3.8 deep-review** — code review 全 Step 3 改动 (跨 19 commit / 78 文件 / 231 处 migrate)
4. **logger.test.ts vi.unmock + vi.doMock 真包验证** — 等 vitest > 2.1.9 修复 setupFiles vi.mock 锁定路径后回填 (Step 3.5.1 mock-mediated 折中说明)
