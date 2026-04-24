# CHANGELOG_21: 双对抗架构评审 Phase 1-3 — 渐进拆分 + 测试基建 + 多模块解耦

## 概要

承接 CHANGELOG_20 的 Phase 0 H 级隐患修复，本次按 `~/.claude/plans/cheeky-twirling-petal.md` 落地 Phase 1-3：SettingsDialog 渐进拆分、引入 vitest 测试基建、ingest 拆 5 段 + 5 种时序单测、SettingsSet 8 函数化 + N6 事务保护 + N8 hookServerToken 分支、notify event-router 抽离、summarizer 错误诊断聚合到设置面板。共 6 处主线改动，typecheck + 14 个单测全过。

## 变更内容

### Phase 1：SettingsDialog 渐进拆分（CHANGELOG_20 / I）

- 新增 `src/renderer/components/settings/controls.tsx`（266 行）：通用控件 `Section` / `Toggle` / `NumberInput` / `SoundPicker` / `ExecutablePicker` / `NotificationTestRow`
- 新增 `src/renderer/components/settings/ClaudeMdEditor.tsx`（155 行）：CLAUDE.md 编辑器，**显式声明与父级 dirty contract**（`onDirtyChange` props 注释保留隐式契约边界）
- `src/renderer/components/SettingsDialog.tsx` 720 行 → 338 行（46% 缩小），只剩外壳 + dirty guard + IPC handlers + SettingsBody 编排
- **顺手补 [N7]**：`update` / `installHook` / `uninstallHook` 三处 try/finally 加 catch，新增 `actionError` state 显示在顶部独立 banner（与 loadError 分两个 slot 不互相覆盖）

### Phase 2.1：vitest 测试基建（CHANGELOG_20 / N3，[B] 前置）

- 新增 `vitest.config.ts`：alias 与 `electron.vite.config.ts` 一致（`@main` / `@shared`），node 环境
- `package.json` 加 `test` / `test:watch` 脚本
- 装 `vitest@^2`（vite 5 兼容；vitest 4 要求 vite ≥ 6 暂不升）
- 新增 `src/main/store/payload-truncate.test.ts`（8 测试）作为 smoke + 同时验证 N1 截断行为
- **修了 N1 实现 bug**：测试发现「单字段超 8KB 但整体 < 256KB 时不触发截断」，改为「总是 shrink 已知大字段（即使整体 < 256KB）」，节省 DB 空间

### Phase 2.2：SessionManager.ingest 拆 5 段 + 5 种时序单测（CHANGELOG_20 / B）

- `src/main/session/manager.ts` 90 行 ingest 拆为：
  - `dedupOrClaim(event)` — 去重 / 时序兜底 claim，必须留在最前
  - `ensureRecord(event)` — 取/建 SessionRecord，复活 closed 走 ensure 内部
  - `persistEventRow(event)` — events 表落库（payload 截断走 N1）
  - `persistFileChange(event)` — file-changed 事件附带 file_changes 落库（独立处理 30 行解析）
  - `advanceState(record, event)` — activity 状态机推进 + lifecycle 复活 + emit
- ingest 主体 ≤ 15 行，注释强调「dedupOrClaim 必须留在最前」硬约束
- 新增 `src/main/session/__tests__/manager.test.ts`（6 测试）覆盖：hook 先到 / SDK 先到 + 后续同 id hook 被丢 / 同 cwd 多 hook（pendingSdkCwds 兜底） / hook 后到（已接管）被丢 / file-changed 序列化 / claim 早退顺序

### Phase 3.1：SettingsSet 拆 8 函数 + [N8] + [N6]（CHANGELOG_20 / A）

- `src/main/ipc.ts` SettingsSet handler 67 行 → 30 行主体，9 个 helper 在 module level：
  - `applyLifecycleThresholds` / `applyLoginItem` / `applyAlwaysOnTop` / `applyPermissionTimeout` / `applyCodexCliPath` / `applySummaryInterval` / `warnHookServerPort` / `warnHookServerToken`（**N8 新增**） / `invalidateClaudeMdCache`
- **N6 事务保护**：handler 内 `before = settingsStore.getAll()` 快照 → patch → try { 9 个 apply } catch { rollback patch 涉及的 keys → throw 给 UI }，避免「DB 改了 / 运行时半生效」
- **保持调用顺序与判定条件不变**（CLAUDE.md 强调 SettingsSet 是「即改即生效中转点」）

### Phase 3.2：notify event-router 抽离（CHANGELOG_20 / F）

- 新增 `src/main/notify/event-router.ts` 单函数 `routeEventToNotification(event)`：把原 `index.ts:73-100` 30 行 notify 路由（waiting / cancelled / finished）从 emit 回调里剥离
- `src/main/index.ts` 的 `adapterRegistry.initAll` emit 回调缩到 2 行：`sessionManager.ingest(event); routeEventToNotification(event);`
- bootstrap 回归装配胶水职责，新增 kind→通知规则只动 event-router

### Phase 3.3：summarizer 错误诊断聚合（CHANGELOG_20 / G）

- `src/main/session/summarizer.ts` 加 `lastErrorBySession: Map<sessionId, { message, ts }>`：`scanAll` 顶层 catch 时 set；成功 summarize 后 delete 对应 sessionId（避免历史错误一直挂）；`session-removed` handler 同步 delete
- 新增 public `getLastErrors(): Record<sessionId, { message, ts }>`
- `src/shared/ipc-channels.ts` 加 `IpcInvoke.SummarizerLastErrors`
- `src/main/ipc.ts` 加 handler
- `src/preload/index.ts` 加 `summarizerLastErrors()` facade
- 新增 `src/renderer/components/settings/SummarizerErrorsDiagnostic.tsx`：在「间歇总结」section 末尾按 ts desc 显示前 5 条；空时显示「最近无 LLM 总结错误」
- **走"诊断聚合"路径而非 UI 告警条 spam**（plan 调整后的方向）

## 验证

- `pnpm typecheck` ✅ 通过
- `pnpm test` ✅ 14 passed（payload-truncate 8 + manager.ingest 6）
- 后续手测（用户重启 dev 时验证）：
  - **Phase 1**：HMR 即时生效，打开设置面板挨个 Section 点一遍；ClaudeMdEditor 的 dirty guard 仍然工作（编辑后点 ✕ 关闭弹「未保存」确认）
  - **Phase 2/3 dedup 时序回归**：开 SDK 会话同时终端 hook 跑同 cwd，确认不出现两份会话；hook curl `127.0.0.1:47821/hook/sessionstart` 也能正常入库
  - **N6 事务保护**：人工注入 applyXxx throw（如临时给 `setLoginItemSettings` 抛错），确认 DB 不被部分写入
  - **N8 hookServerToken**：暂无 UI 入口，但日后加 token 编辑时 dispatcher 能 warn 而不是 silent fail
  - **Summarizer 错误诊断**：模拟 LLM 失败（断网或超时改 1ms）确认「间歇总结」section 末尾出现红色错误卡片

## 关联文件清单

- 新增（5 个）：`vitest.config.ts` / `src/main/notify/event-router.ts` / `src/renderer/components/settings/{controls,ClaudeMdEditor,SummarizerErrorsDiagnostic}.tsx`
- 新增测试（2 个）：`src/main/store/payload-truncate.test.ts` / `src/main/session/__tests__/manager.test.ts`
- 改动主线：`src/main/{ipc,index,session/manager,session/summarizer,store/payload-truncate}.ts` + `src/renderer/components/SettingsDialog.tsx` + `src/preload/index.ts` + `src/shared/ipc-channels.ts` + `package.json`

## 备注

- Phase 4（[N5] FTS5 历史搜索 / [N4] migrations 单轨化）按 plan **听用户反馈再决定**——前者等用户反馈历史卡顿再上 SQLite migrations，后者删 `v001_init.sql` 或反向归并都是顺手活
- 不进 plan 的 [N9] adapter capabilities 链式访问漏 ?. / [N10] claude-config dev/prod 路径分歧 / [N11] closed 复活双广播 / [N12] route-registry 缺 unregister 已记入 plan 的 tally section，三次撞同类再升级
- vitest 现版 2.1.9，未来 vite 升 ≥ 6 时可升级 vitest 4
- 决策对抗已在 plan 阶段完成（Opus 挑刺 + codex GPT-5.4 xhigh 异源对抗，三态裁决推翻 plan 4 处错判 + 补 12 个盲点），实施按对抗后的路线落地无新分歧
