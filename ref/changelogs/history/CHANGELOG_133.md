# CHANGELOG_133 — Plan `add-claude-cli-path-override-and-bump-sdks-20260520`: 加 `claudeCliPath` 设置项(对齐 codex)+ bump 应用内置 SDK 版本

## 概要

实施 `plans/add-claude-cli-path-override-and-bump-sdks-20260520.md` 全部 6 phases — 两件主题相关任务一并做:① 补 `claudeCliPath` 设置项填 historical asymmetry(codex 早就有 `codexCliPath` 让 user override SDK binary,claude 没对应入口),② bump 内置 SDK 版本至最新稳定版(spike 实测 0 breaking)。共 5 commits + 6 文件 + 净 +40/-2 LOC。

## 变更内容

### Phase 1 commit `99a9373` — 加 claudeCliPath 设置项(镜像 codex 字面对称)

5 文件改动 ~32 LOC base(plan §动机 LOC 估算精确数字):

- **`src/shared/types/settings.ts`**:加 `claudeCliPath: string | null` 字段(jsdoc 镜像 `codexCliPath` 风格)+ `DEFAULT_SETTINGS.claudeCliPath = null`
- **`src/main/ipc/settings.ts`**:加 `applyClaudeCliPath` no-op 钩子(plan §设计决策 D6:claude SDK 不持 instance pool / per-session bridge cache 不需 invalidate;占位 if-block 与 `applyCodexCliPath` 对称读者一眼看出对称结构 + 注释解释「未来加 logic 时怎么改」)
- **`src/main/adapters/claude-code/sdk-bridge/index.ts:253`** + **`src/main/session/oneshot-llm/claude-runner.ts:55`**:加 inline priority chain `(claudeCliPath && claudeCliPath.trim()) || getPathToClaudeCodeExecutable()`(镜像 codex `codex-instance-pool.ts:46` + `codex-cli/sdk-bridge/index.ts:240` inline pattern)+ 顶部加 `import { settingsStore }`
- **`src/renderer/components/settings/sections/ExternalToolsSection.tsx`**:加 `<ExecutablePicker>` 控件(label="Claude 二进制路径",紧挨现有 Codex 控件之后)

测试 mock 改动 0 LOC — plan §设计决策 D8 + spike3 §Step 8 实测 5 文件分布表:priority chain `(claudeCliPath && trim) || fallback` 短路语义自动接住未 mock 的 `settingsStore.get` 返 undefined / null;现有 5 个测试已直接 / 间接 mock 接住(`createsession-fail-fast` / `setttimeout-fallback-symmetry` / `sdk-bridge.recovery` / `set-permission-mode-rollback` / `hand-off`)。

### Phase 2 commit `b855fe1` — bump @anthropic-ai/claude-agent-sdk 0.2.118 → 0.3.144

major version 数字升但 d.ts diff 全 additive(spike1 实测铁证):

- typecheck 0 errors / test 762 pass + 76 skip 0 fail
- d.ts 5332 → 5722 行 +390 行全 additive
- 移除 4 个 `unstable_v2_*` / `SDKSession` / `PromptRequest*` 实验导出 — agent-deck 0 grep 命中 → 完全无关
- `query()` 函数签名 + Options 字段(cwd / permissionMode / executable / env / pathToClaudeCodeExecutable / sandbox / mcpServers / hooks 等 24+ 字段)保持稳定
- 新增 `Options.toolAliases` / `ResolvedSettings` / `SDKPermissionDeniedMessage` / `SDKTaskSummaryMessage` 等 additive 字段
- asarUnpack glob `@anthropic-ai/claude-agent-sdk-{darwin,linux,win32}-*/**/*` 仍命中新版命名(spike1 §asarUnpack 实测)
- peer dep `@anthropic-ai/sdk@>=0.93.0` warn(0.81 间接 dep)— 不阻塞 install/typecheck/test/build,plan §D9 留 follow-up backlog

### Phase 3 commit `38483f1` — bump @openai/codex-sdk 0.120.0 → 0.131.0

11 minor 跨越但 d.ts diff 仅 +2 行 additive(spike2 实测铁证):

- typecheck 0 errors / test 762 pass + 76 skip 0 fail(与 Phase 2 累积一致)
- d.ts diff 仅 `reasoning_output_tokens: number` 加在 turn usage 接口(reasoning model 专用 token 计数;agent-deck 0 grep 命中此字段)
- 所有 agent-deck 直接使用的 `Codex` / `Thread` / `Input` / `ThreadEvent` / `ThreadOptions` type 保持稳定
- `codexPathOverride` constructor option 保留 → agent-deck `cachedCodex = new sdk.Codex({ codexPathOverride })` 路径不动
- vendored binary 路径结构 0.120.0 → 0.131.0 完全一致(`vendor/<triple>/codex/codex`),`resolveBundledCodexBinary()` PLATFORM_BINARY_MAP 不需改(spike2 §vendored binary 实测 5 platform 全表)
- asarUnpack glob `@openai/codex-{darwin,linux,win32}-*/**/*` 仍命中新版命名(spike2 §asarUnpack 实测)
- CHANGELOG_130 stateless HTTP transport pattern + mcp-sdk 1.29 ToolAnnotations 不受影响(Codex SDK 与 agent-deck-mcp 解耦)

### Phase 4.1 commit none — production build smoke ⚑ checkpoint

`pnpm build` 187+8+449 modules transformed,无新错误(唯一 warning 是历史 dynamic-vs-static import 问题不属本 plan)。Phase 4.2-4.5 完整 e2e smoke(应用 boot + claude/codex session sandbox 切档 + mcp tool approval + deep-review SKILL 完整 spawn pair shutdown + hand_off baton cwd resilience)deferred to user 实测 — 部分 implicit 已通过本会话编排路径覆盖(本会话由 hand_off baton 起来 + 跑 deep-review SKILL 双 reviewer pair),完整 5 大 smoke 需 user 装 .app 后实测。

### Phase 5 commit `d6d72d3` — Deep-Review SKILL kind='code' R1 fix(tooltip 工具无关化)

异构对偶 reviewer pair(reviewer-claude Opus 4.7 + reviewer-codex gpt-5.5)出 R1 6 个 finding + R2 验证终态 ✅ 可合:

- ❌ **反驳 1 真 MED**(reviewer-codex 单方 / asarUnpack glob 在 pnpm 布局兼容性):历史 .app 实证 `/Applications/Agent Deck.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/version: 0.2.118` + `@openai/codex-darwin-arm64/version: 0.120.0` 都在 unpacked 顶层 → electron-builder pnpm-aware hoist 真生效。R2 reviewer-codex 接受反驳撤回 R1 MED
- ✅ **修 1 真 MED**(reviewer-claude 单方 / plan §当前进度 stale):plan §当前进度 + §下一会话第一步 v3 修订反映 Phase 1+2+3 commit hash + Phase 4.1 build GREEN + Phase 5 R1 完成
- ✅ **修 1 真 LOW**(reviewer-codex 单方 / `controls.tsx:265+273` ExecutablePicker tooltip 硬编码「codex」):工具无关化改成「应用内置可执行文件」让 Claude / Codex 双 picker 复用控件不显示错文案
- ❓ **3 LOW 接受作 backlog / Phase 4 兜底**:user override 无 unit test(codex 等价无专测,Phase 4 e2e 兜底)/ asarUnpack dist 实测 sanity check(Phase 4.1 task)/ peer dep runtime 兼容(plan §D9 backlog)
- R2 双 reviewer 一致 ✅ 可合 + 关键 INFO:tooltip fix 必须 commit 才可 archive_plan(precheck dirty reject)

### Phase 6 collected commits — changelog + archive_plan

本 changelog + plan 归档走 `mcp__agent-deck__archive_plan` 自动化(自动 ff-merge worktree → main / mv plan → `<main-repo>/plans/` / mv spike-reports/ / 同步 plans/INDEX.md / git commit / 删 worktree + branch + baton-cleanup phase 1+2)。

## verify

- typecheck GREEN(每 phase 末 ⚑ checkpoint)
- 762 tests pass | 76 skipped | 0 fail(每 phase 末 ⚑ checkpoint,与 spike1+2 baseline 一致)
- production build GREEN(`pnpm build` 187+8+449 modules transformed)
- Phase 5 Deep-Review SKILL kind='code' R1+R2 双 reviewer ✅ 可合;0 残留 真 HIGH / 真 MED

## 已知 follow-up

- **F1**(LOW backlog,plan §D9):`@anthropic-ai/sdk` peer dep warn — bump claude-agent-sdk 0.3.144 声明 `>=0.93.0` peer 但实际间接装 0.81.0。pnpm WARN 不阻塞 install / typecheck / test;runtime 兼容性靠 Phase 4.2 e2e 兜底。如未来撞 runtime error 触发 follow-up plan `pnpm add @anthropic-ai/sdk@^0.93.0`
- **F2**(LOW backlog,plan §D7):claudeCliPath 不加 existsSync 护栏 — 镜像 codex 现行;user 填错路径走 SDK spawn 自然 ENOENT + recoverer cwd fallback。如未来想加 existsSync 早期校验 follow-up plan
- **F3**(LOW backlog,plan §D8 §1.7):新加 priority chain 行为单测(~80 LOC,验证 user override 真生效)— 当前 codex 等价 priority chain 也无专测,本 plan 接受同款覆盖度;Phase 4.2 e2e smoke 兜底 verify
- **F4**(user 实测 deferred):Phase 4.1-4.3 完整 e2e smoke — `pnpm dist` 出 .app + install + 起 claude/codex session + sandbox 切档 + mcp tool approval gate;Phase 4.4 完整 SKILL shutdown + Phase 4.5 cwd resilience verify

## 关键 commits

- `99a9373` Phase 1: add claudeCliPath setting (mirror codex)
- `b855fe1` Phase 2: bump @anthropic-ai/claude-agent-sdk 0.2.118 → 0.3.144
- `38483f1` Phase 3: bump @openai/codex-sdk 0.120.0 → 0.131.0
- `d6d72d3` fix(ui): tooltip 措辞工具无关化 (Phase 5 R1 C-LOW-1)

## 详

- 归档 plan: [`plans/add-claude-cli-path-override-and-bump-sdks-20260520.md`](../../plans/history/add-claude-cli-path-override-and-bump-sdks-20260520.md)
- spike-reports: [`plans/add-claude-cli-path-override-and-bump-sdks-20260520/spike-reports/`](../../plans/history/add-claude-cli-path-override-and-bump-sdks-20260520/spike-reports)(spike1 claude SDK bump / spike2 codex SDK bump / spike3 claudeCliPath design 验证)
- 平行 sister plan: `plans/hand-off-session-adopt-teammates-20260520.md`(hand_off_session adopt_teammates,LOW 优先级,本 plan 不 cover)
