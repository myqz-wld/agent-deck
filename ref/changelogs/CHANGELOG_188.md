# CHANGELOG_188 — codex-sdk 0.135 升级 + Issue UI 沙盒/刷新修复（deep-review-multi-area-20260530）

> 多区 deep review 的代码部分（Area 2 Issue UI bug + Area 5 codex SDK 升级）。Area 1/3（提示词资产 .md）
> 检测到**并发会话正在同一工作树编辑** `claude-config/CLAUDE.md` / `codex-config/CODEX_AGENTS.md` / `INDEX.md`
> + 新建 `CHANGELOG_187.md`（mtime 19:28–19:30，本会话期间，非本会话所为）→ 为避免并发写冲突**本轮不碰 .md
> 资产**，留并发会话收口。本 changelog 只覆盖纯代码改动（src/** + package.json），与并发 .md 工作零文件重叠。

## Area 5：@openai/codex-sdk `^0.131.0` → `^0.135.0`

- **package.json** 依赖升级；`@openai/codex`（codex CLI 二进制宿主包）随之 0.131.0 → 0.135.0。
- **type surface 零破坏**：`dist/index.d.ts` diff 仅一处 additive — `McpToolCallItem.result._meta?: unknown` 新增可选字段。
  本仓消费的 `ThreadOptions` / `Codex` / `startThread` / `resumeThread` / `Thread` / `ThreadEvent` / `Input` 全 byte-identical。runtime exports 一致。
- **HIGH 回归修复（codex 二进制 vendor 布局变更）**：`src/main/adapters/codex-cli/sdk-bridge/codex-binary.ts`
  - 0.135 把 vendored 二进制从 `vendor/<triple>/codex/codex` 挪到 `vendor/<triple>/bin/codex`（同时 `path/`→`codex-path/` + 新增 `codex-package.json`）。
  - 原 `resolveBundledCodexBinary()` 硬编码旧 `codex/codex` 路径 → 升级后**打包 .app 找不到二进制**（typecheck 抓不到纯 path 字符串漂移），codex 整条链在打包版失效。
  - 修法：先探 new `bin/<binName>` 后 fallback legacy `codex/<binName>`，与 SDK 内部 `resolveNativePackage` 同序双探测，跨 SDK 版本都稳。
  - **回归测试** `__tests__/codex-binary-layout.test.ts`（5 case：dev null / 双缺 null / new 命中 / legacy fallback / new+legacy 优先 new）。
- `electron-builder install-app-deps` 已重建 better-sqlite3（Electron 33 ABI，无 NODE_MODULE_VERSION 问题）。
- `asarUnpack` glob（`@openai/codex-darwin-*/**/*` 递归）+ pnpm 平台包命名（`@openai/codex@<ver>-darwin-arm64`）两版一致，无新打包风险。
- 全量测试 1094 passed（codex adapter 106 + 新 layout 5）。

## Area 2：Issue「起新会话解决」对话框

- **Bug #1 沙盒选项缺失**（`ResolveInNewSessionDialog.tsx`）：IPC schema / handler / helper 早已支持 `codexSandbox` / `claudeCodeSandbox`，仅对话框 UI 没暴露 → 起新会话只能走全局默认，无法 per-session 覆盖。补 claude/codex 两档沙盒下拉 + permissionMode 按 adapter capability 显隐（与 `NewSessionDialog` 对齐：codex 无 permissionMode）。
- **Bug #2 状态不刷新**（`IssueDetail.tsx`）：状态下拉绑 `editing` 缓冲，而 `onResolved` 只 `setIssue` 不同步 `editing`，且 `editing` 的 useEffect 仅依赖 `issueId` → 起新会话回写 `status='in-progress'` 后必须切走再切回才显示。
  - 修法：新增 store-`updatedAt` 订阅 effect，issue 行变即同步 `issue` + `editing`；草稿守护（`editingMatches`）让用户编辑中不被外部 event 吞输入；`saving` 期间跳过；appendices `?? prev` 防丢（`list()` 路径 store 行不带 appendices，event 路径都带）。
- **UX 增强**：`IssueDetail` 的「来源会话 / 解决会话」从纯文本 UUID 改为可点击跳转（`onOpenSession` 经 App → IssuesPanel → IssueDetail 透传，复用 PendingTab/TeamHub 同款 `setView('live') + select(sid)`），补齐「起新会话解决」闭环。
- **重构**：抽 `src/renderer/lib/sandbox-options.ts`（新建会话类对话框共享 permission/sandbox 选项），消除 `NewSessionDialog` 与 `ResolveInNewSessionDialog` 的选项数组重复（原本会三处复制）。

## 验证

- `pnpm typecheck` 通过；`pnpm test` 1094 passed / 197 skipped（skip 为 SQLite binding ABI 门控，pre-existing）。
- issues IPC 32 test + codex adapter 106 test 全绿。
