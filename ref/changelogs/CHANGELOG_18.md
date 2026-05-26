# CHANGELOG_18: REVIEW_2 二十处修复 + 用户报告 2 BUG 修复 + REVIEW_X 模板加 frontmatter + agent-deck CLAUDE.md 注入开关 + codex 拆批跑约定

## 概要

REVIEW_2 双对抗（Claude Opus 4.7 xhigh + Codex gpt-5.4 xhigh 三批）+ 用户主动报告 2 BUG，三方裁决出 20 条真问题，本次一次性修完。同时落地 ~/.claude/CLAUDE.md「已审文件过期」机制 + REVIEW_X.md 模板加 frontmatter + fenced review-scope，并回填 REVIEW_1.md。

后续追加：
- ~/.claude/CLAUDE.md 加「codex CLI 大任务必须拆小批 + 后台并发跑」实证教训段（REVIEW_2 中 codex 单 prompt 卡 17 分钟根因总结）
- 设置面板加「启用 agent-deck CLAUDE.md 注入」开关，让用户可以彻底禁用打包注入

## 变更内容

### `src/main/adapters/claude-code/hook-installer.ts`

- readSettings parse 失败抛错而非回退 `{}`，避免后续 install 把整个 settings.json 重写成只有 hooks 的对象抹掉用户原 permissions/mcpServers/env
- status() 路径单独 try/catch readSettings，失败时退化为「未安装 + console.warn」避免坏 JSON 让 UI 设置面板卡死

### `src/main/adapters/claude-code/sdk-injection.ts`

- `saveUserAgentDeckClaudeMd` 改 atomic write（mkdir + write tmp + renameSync），与 hook-installer.writeSettings 同模式；崩溃 / 磁盘满不再留半截 CLAUDE.md 副本

### `src/main/cli.ts`

- 新增 `VALUE_REQUIRED_FLAGS` 集合（cwd/agent/prompt/model/permission-mode/resume）；缺值时 `parseFlags` 抛错而不是吞为 true 后回落默认（避免 `--cwd`（缺值）静默落到 homedir）
- `applyCliInvocation` 加 `if (adapter.capabilities.canSetPermissionMode)` 守卫；codex-cli 不再被污染 sessions.permission_mode 列

### `src/main/store/file-change-repo.ts`

- `rowToRecord` 用 try/catch 包 `JSON.parse(metadata_json)`，失败回 `{}` + warn；单条坏数据不再炸全列表
- `listForSession` SQL 加 `, id DESC` secondary key；同毫秒写入次序稳定

### `src/renderer/components/SettingsDialog.tsx`

- 顶层加 `claudeMdDirtyRef` + `guardedClose` 拦截关闭：ClaudeMdEditor 有未保存草稿时 `confirmDialog` 二次确认；ClaudeMdEditor 通过 `onDirtyChange` 上报，卸载时显式重置防 ref 残留
- `NumberInput` 改 string 草稿 + onBlur/Enter commit + clamp(min, max)；Escape 取消草稿；阻断 `hookServerPort=0` / `activeWindowMs=0` 这种"语义违法但 isFinite=true"的值

### `src/renderer/components/ActivityFeed.tsx`

- 抽 `eventKey()` 函数代替 `${e.ts}-${idx}`：tool-use 用 toolUseId、waiting-for-user 用 type+requestId、file-changed 用 ts+filePath、其余用 sessionId+kind+ts；头部插入新事件时旧 row 不再全 remount，MD/TXT 切换 / 展开状态 / 表单输入保留

### `src/renderer/components/SessionDetail.tsx`

- listFileChanges useEffect 重写为融合方案（修用户报的 BUG 1 + Codex 报的切会话 race）：
  - 订阅 `agent-event` 'file-changed'，过滤 `e.sessionId === session.id`
  - 300ms 节流（合并 MultiEdit 拆出的 N 条 file-changed）
  - sequence counter `++req` + `cur !== req` 丢弃过期 IPC 结果
  - disposed flag 防卸载/换会话后 setState
  - selection 保留：filePath/changeId 仍在新数据里则保留，否则 fallback 到 latest

### `src/renderer/components/HistoryPanel.tsx`

- 加 `reqIdRef` sequence counter；`reload` then 回调比较 `cur !== reqIdRef.current` 丢弃过期请求；筛选/切「仅归档」时旧慢请求不再覆盖新结果

### `src/renderer/components/PendingTab.tsx`

- 渲染 row 的 `<ol>` 在 batchBusy 时加 `pointer-events-none opacity-50`；批量响应期间单条按钮锁住，避免并发响应撞主进程 "request not found"

### `src/renderer/components/SummaryView.tsx`

- useEffect 加 `aborted` flag + cleanup 设 true；卸载/换会话后旧 IPC then 不再 setState

### `src/renderer/components/diff/renderers/ImageBlobLoader.tsx`

- 仅 `result.ok === true` 才入缓存；失败结果（enoent/io_error/denied 等）不缓存，下次会重试

### `src/renderer/components/diff/renderers/PdfDiffRenderer.tsx`

- 话术从「PDF diff（待实现）」改为「PDF diff 暂不支持」+ 加说明「改动已记录在 file_changes 表里，未来支持后会自动展示」

### `src/renderer/hooks/use-event-bridge.ts`

- 调换启动顺序：先注册所有 listener 再 IIFE 拉快照；与 setSessions 的 prune + 同 id 覆盖语义配合，await listSessions 期间到达的 session-upserted 不再被全量覆盖

### `src/renderer/main.tsx`

- `isMonacoUnmountRaceNoise` 加双字段判定 `name === 'Canceled' && message === 'Canceled'`（对齐 monaco `isCancellationError`），不只看 message 防误吞真错误；用户报的偶发红屏修复
- `showFatal` 加 `FATAL_AUTO_DISMISS_MS=8000` 自动消失（fade 400ms 过渡）；手动 ✕ 仍立刻关；统一 `remove()` 内 clearTimeout 防残留

### `src/renderer/stores/session-store.ts`

- `setSessions` 加 `validIds` 集合 + `prune` 工具函数遍历 7 张 by-session Map 删 orphan；selectedSessionId 不在新集合也清；HMR / history 视图切换不再留孤儿
- `setSummaries(空数组)` 同步 `latestMap.delete(sessionId)`；SessionCard 不再继续显示已被服务端删除的旧 summary

### `~/.claude/CLAUDE.md` + `resources/claude-config/CLAUDE.md`（同步）

- 新增「已审文件过期」节（File-level Review Expiry）：净 churn ≥ min(200, LOC*30%) / distinct commit ≥ 3 / ≥ 90 天 + 改过 / `expired: true` 兜底，OR 关系任一命中即过期；rename/move 不继承；本轮范围 = 未审 ∪ 已审过期 ∪ scope_unknown，默认硬合并；附自检命令
- `reviews/REVIEW_<X>.md` 模板加 YAML frontmatter（review_id / reviewed_at / expired / skipped_expired）+ fenced ```` ```review-scope ```` block；覆盖基线 commit 由 `git log --diff-filter=A -- reviews/REVIEW_X.md` 自动取，不写 hash
- `### codex CLI 模板`节末尾追加「大任务必须拆小批 + 后台并发跑」段：单 prompt 文件清单 ≥ 15 / 总长 ≥ 80 行 + xhigh 时容易卡在 wc -l 阶段 10+ 分钟（实证 REVIEW_2 codex 单 prompt 卡 17 分钟）。给出拆批姿势（≤10 文件/批 / prompt ≤30 行 / `run_in_background: true` 并发 / `timeout: 600000` 仍按重 review 给 / prompt 顶部禁止 codex 自拉背景）

### `src/shared/types.ts`

- AppSettings 加 `injectAgentDeckClaudeMd: boolean` 字段；DEFAULT_SETTINGS 默认 true

### `src/main/adapters/claude-code/sdk-injection.ts`

- `getAgentDeckSystemPromptAppend()` 入口处先检查 `settings.injectAgentDeckClaudeMd`，false 直接返回空串（开关比 cache 优先，关掉立刻生效）

### `src/main/ipc.ts`

- `SettingsSet` handler 加分发：改 `injectAgentDeckClaudeMd` 时调 `invalidateAgentDeckSystemPromptAppend()` 清缓存
- 新 import `invalidateAgentDeckSystemPromptAppend`

### `src/renderer/components/SettingsDialog.tsx`（追加）

- 「应用约定（CLAUDE.md）」节首部加 Toggle「启用 agent-deck CLAUDE.md 注入」+ 一行说明：「关闭后下次新建会话不再注入；已运行的会话已固化进 LLM 上下文，关掉不会回收」

### `reviews/REVIEW_1.md`（回填）

- 加 frontmatter（review_id=1, reviewed_at=2026-04-24, expired=false, skipped_expired=[]）
- 加 16 行 ```` ```review-scope ```` block（按字典序，展开原 brace expansion）
- 文本范围摘要从 ` ``` ` 改为 ` ```text ` 标注为人类可读

## 备注

- **修复方案双对抗**：Claude BUG fix Agent A + Codex BUG fix Agent B 独立设计，三态裁决取 BUG 1 选 C + Claude A 节流 + Codex B sequence；BUG 2 取 Claude A 双字段判定（更精确，避免误吞 `Job was Canceled by user`）
- **typecheck 通过**：`pnpm typecheck` 全绿
- 本次没有引入新 agent-pitfall 候选——所有真问题都属 CLAUDE.md「资源清理 & TOCTOU 防线」已知模式
- 关联：[REVIEW_2.md](../reviews/REVIEW_2.md)
