# CHANGELOG_185 — Phase F 架构/流程图：issue-tracker (4) + runtime-logging (2) + 复审

> plan deep-review-and-asset-polish-20260530 §Phase F。为近期两个大改动（issue-tracker-mcp-20260529 + runtime-logging-electron-log-20260529）补 plantUML SSOT；只生成/改 .puml 不渲染（flow-arch SKILL §不渲染）。user 经 AskUserQuestion 确认 scope（issue-tracker 全套 4 张对齐惯例 / runtime-logging 架构+console flow 2 张）。

## 背景

ref/flows (9) + ref/architecture (8) 现有图覆盖 mcp-tool-call / archive-plan / hand-off / sdk-bridge / universal-message，**issue-tracker 与 runtime-logging 零覆盖**。Phase F 补齐 + 复审现有图因本轮改动失真处。

## 变更内容

### F1 issue-tracker 全套 4 张（对齐 archive-plan/hand-off/sdk-bridge 惯例：flow+决策树+架构+状态机）
- **`ref/flows/issue-tracker-flow.puml`**（sequence，7 participant）：agent 写路径 — report_issue 创建（sourceSessionId 闭包注入 / cwd fallback / kind·severity 默认 / emit created）+ append_issue_context（4 道守门 + appendContext 写子表不动 description + logsRef merge + emit appended）+ GC（listForGc 双轨 → 逐条 snapshot+hardDelete+CASCADE+emit hardDeleted）+ event→UI
- **`ref/flows/issue-tracker-append-decision.puml`**（activity）：append 4 道守门决策树 — not-found / source-bound（sourceSessionId≠caller）/ resolved / 软删 reject，与 handler 实现顺序一致
- **`ref/architecture/issue-tracker-architecture.puml`**（component，13 entity）：跨进程 — agent 写通道（2 mcp write tool §不变量 1 只写不查）/ UI 读改删通道（IPC 6 channel + createIssueResolutionSession 绕 spawn-guards）/ GC 调度器 / eventBus→renderer / FK 设计（source·resolution SET NULL vs appendices CASCADE）
- **`ref/architecture/issue-tracker-state-machine.puml`**（state，8 entity）：issue 生命周期 — status 3 态（open/in-progress/resolved 仅 UI 推进，resolved_at 状态机 §D15）× deleted_at 正交（soft-delete↔undelete + GC 双轨硬删 resolved/soft-deleted）

### F2 runtime-logging 2 张（架构 + console flow）
- **`ref/architecture/runtime-logging-architecture.puml`**（component，13 entity）：双进程 electron-log v5 — main logger（app.setName 必先于 getPath('logs') REVIEW_66 / console 接管 / errorHandler + uncaughtException→exit(1)）+ renderer logger（IPC bridge 落同一 file / MODE 守门）+ file transport（按天拆 + cleanup 14天 + File.clear 非 fs.truncate）+ LogsSection IPC + preload-fatal
- **`ref/flows/runtime-logging-flow.puml`**（sequence，6 participant）：init（setName→initialize→resolvePathFn→levels→startCatching→console 接管）+ main 直写 + renderer IPC bridge 落同一份 + fatal（uncaughtException 落盘后 exit(1)，listener 注册序保先落盘后退出）+ preload fatal

### F3 复审现有 9 flow + 8 arch
- **`ref/architecture/agent-deck-mcp-architecture.puml` 更新**（issue-tracker 加 2 tool 失真）：tool 入口/handler facade/dispatch `15 tools`→`17 tools`（3 处）+ 持久层 `4 张数据表`→`5 张数据表(+issue)` + 边标签 `读写 4`→`5`（同图一致）+ 专题子图 note 加 issue-tracker（架构 2 + 流程 2）+ 术语对照加 `issueRepo=issue 表`
- **其余图判定无失真不动**：archive-plan/hand-off/sdk-bridge/message 主题与 issue-tracker/runtime-logging 正交；topic 图内 `4 张数据表` 是该主题 backdrop（hand-off 写 4 实列 3 本就松散，issue 无关）+ tool-call-flow:48 在 impl-branch backdrop（archive/hand-off 不碰 issueRepo）+ hand-off-flow:21 `console.warn` 是 fail-open 行为说明非 logging 机制图示 → 均保留

### F4 INDEX sync
- `ref/flows/INDEX.md` +3 行 / `ref/architecture/INDEX.md` +3 行 + 更新 agent-deck-mcp-architecture 行（17 tool / 5 数据表 + Phase F 关联）

## 验证

- `plantuml -syntax`（非渲染）7 文件（6 新 + 1 改）全过：SEQUENCE×2 / ACTIVITY×1 / STATE×1 / DESCRIPTION×3，0 语法错误
- 画图前读源码对齐（issue.ts 类型 / v026 migration schema+FK / issue-repo update 状态机+listForGc / issue-lifecycle-scheduler GC / ipc/issues 6 handler / append-issue-context 守门顺序 / main+renderer logger / ipc/logs）
- 只生成/改 .puml SSOT 不渲染 PNG/SVG（flow-arch SKILL §不渲染 — user 想看自跑 plantuml CLI）
