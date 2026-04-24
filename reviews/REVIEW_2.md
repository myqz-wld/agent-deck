---
review_id: 2
reviewed_at: 2026-04-24
expired: false
skipped_expired: []
---

# REVIEW_2: renderer + preload + shared + main 周边全审（双对抗 + 用户报项）

## 触发场景

REVIEW_1 修了 main 进程 16 个核心文件 8 处问题后，本轮把范围扩展到 REVIEW_1 完全没看的 renderer + preload + shared + main 周边模块（约 7000 行）。同时用户主动报告了两条体感 BUG：

1. **改动里有时不包含会话内的文件改动**（SessionDetail diff tab 不订阅 file-changed 事件）
2. **偶发 unhandledrejection: canceled 红屏**（main.tsx 噪音白名单漏 monaco Canceled）

## 方法

**双对抗配对**（CLAUDE.md「决策对抗」规范）：

- **Agent A**：Claude（`Explore` general-purpose subagent，Opus 4.7 xhigh），一次性扫全部 53 个文件，给 14 条候选
- **Agent B**：Codex CLI（gpt-5.4 xhigh，superprocess `codex exec --sandbox read-only --skip-git-repo-check`，model_reasoning_effort=xhigh）。第一次单 prompt 把 53 个文件灌进去，超过 17 分钟卡在初步扫描没动 → 中止；改成**拆 3 批 + 精简 prompt**（≤30 行/批）后顺利返回：
  - batch 1 (becijjk8w)：renderer 主件 10 个 → 8 条
  - batch 2 (bb661gkhq)：renderer 小件 + preload + shared + diff 23 个 → 8 条
  - batch 3 (btalv267c)：main 周边 20 个 → 7 条
- **三方裁决**：A + B + 用户报项 → 现场用 Read 工具核实每条，剔除假阳性 / 重叠合并

**修复方案双对抗**（针对用户报的 2 条 BUG）：

- Claude BUG fix Agent A (Opus 4.7 xhigh) + Codex BUG fix Agent B (gpt-5.4 xhigh) 独立各给一份方案，三态裁决出综合方案

**范围**：53 个文件（renderer / preload / shared / main 周边），约 7200 行

```text
src/renderer/**/*.{ts,tsx} (29 个)
src/preload/index.ts
src/shared/*.ts (3 个)
src/main/{cli,event-bus}.ts
src/main/notify/{visual,sound}.ts
src/main/permissions/scanner.ts
src/main/hook-server/route-registry.ts
src/main/adapters/{aider,generic-pty,registry,types}.ts
src/main/adapters/claude-code/{hook-routes,hook-installer,sdk-loader,sdk-injection,settings-env,index}.ts
src/main/adapters/codex-cli/{sdk-loader,index}.ts
src/main/store/{summary-repo,file-change-repo}.ts
```

**机器可读范围**（File-level Review Expiry 用，按字典序）：

```review-scope
src/main/adapters/aider/index.ts
src/main/adapters/claude-code/hook-installer.ts
src/main/adapters/claude-code/hook-routes.ts
src/main/adapters/claude-code/index.ts
src/main/adapters/claude-code/sdk-injection.ts
src/main/adapters/claude-code/sdk-loader.ts
src/main/adapters/claude-code/settings-env.ts
src/main/adapters/codex-cli/index.ts
src/main/adapters/codex-cli/sdk-loader.ts
src/main/adapters/generic-pty/index.ts
src/main/adapters/registry.ts
src/main/adapters/types.ts
src/main/cli.ts
src/main/event-bus.ts
src/main/hook-server/route-registry.ts
src/main/notify/sound.ts
src/main/notify/visual.ts
src/main/permissions/scanner.ts
src/main/store/file-change-repo.ts
src/main/store/summary-repo.ts
src/preload/index.ts
src/renderer/App.tsx
src/renderer/components/ActivityFeed.tsx
src/renderer/components/FloatingFrame.tsx
src/renderer/components/HistoryPanel.tsx
src/renderer/components/ImageThumb.tsx
src/renderer/components/MarkdownText.tsx
src/renderer/components/NewSessionDialog.tsx
src/renderer/components/PendingTab.tsx
src/renderer/components/PermissionsView.tsx
src/renderer/components/SessionCard.tsx
src/renderer/components/SessionDetail.tsx
src/renderer/components/SessionList.tsx
src/renderer/components/SettingsDialog.tsx
src/renderer/components/StatusBadge.tsx
src/renderer/components/SummaryView.tsx
src/renderer/components/diff/DiffViewer.tsx
src/renderer/components/diff/SessionContext.ts
src/renderer/components/diff/install.ts
src/renderer/components/diff/registry.ts
src/renderer/components/diff/renderers/ImageBlobLoader.tsx
src/renderer/components/diff/renderers/ImageDiffRenderer.tsx
src/renderer/components/diff/renderers/PdfDiffRenderer.tsx
src/renderer/components/diff/renderers/TextDiffRenderer.tsx
src/renderer/components/diff/types.ts
src/renderer/components/pending-rows/index.tsx
src/renderer/hooks/use-event-bridge.ts
src/renderer/lib/ipc.ts
src/renderer/lib/session-selectors.ts
src/renderer/main.tsx
src/renderer/stores/session-store.ts
src/shared/ipc-channels.ts
src/shared/mcp-tools.ts
src/shared/types.ts
```

> 覆盖基线 commit 由 `git log --diff-filter=A --format=%H -n 1 -- reviews/REVIEW_2.md` 自动取（本份 REVIEW 落地 commit）。

**约束**：跳过 REVIEW_1 已修过的 8 处（cwd fuzzy / pendingClaim release / loadImageBlob TOCTOU / toolUseNames / queryLoop catch warn / ImageRead 500 / before-quit async / npm_package_version）。Claude A 报项被反驳率高，Codex 三批独发率高（与 REVIEW_1 经验一致）。

## 三态裁决结果

总报项 25（codex 三批）+ 14（Claude A）+ 2（用户）= **41 候选 → 16 真问题 / 14 反驳 / 7 部分**。

### ✅ 真问题（按严重度）

| # | 严重度 | 文件:行号 | 问题 | A | B | 用户 |
|---|---|---|---|---|---|---|
| 1 | HIGH | hook-installer.ts:62 | settings.json parse 失败回退 `{}` 后 install 把整个文件写成只有 hooks，**permissions/mcpServers/env 全丢失** | ❌ | ✅ batch 3 | — |
| 2 | HIGH | SettingsDialog.tsx:76 | 关闭弹窗不拦截 ClaudeMdEditor dirty，**误关一次丢整段 CLAUDE.md 编辑**（dirty state 在子组件未上报） | ❌ | ✅ batch 1 | — |
| 3 | HIGH | ActivityFeed.tsx:125 | key=`${e.ts}-${idx}` + session-store 头部插入 → **每条新事件让所有 row 全 remount**，MD/TXT 切换 / 展开状态 / 表单输入全丢 | ❌ | ✅ batch 1 | — |
| 4 | HIGH | SessionDetail.tsx:90 | 不订阅 file-changed 事件 + 切会话 race（合并） | ❌ | ✅ batch 1 | ✅ |
| 5 | MED | SettingsDialog.tsx:333 | NumberInput 无 min/max clamp，hookServerPort=0 / activeWindowMs=0 立即生效 | ❌ | ✅ batch 1 | — |
| 6 | MED | session-store.ts:267 | setSummaries(空数组) 不清 latestSummaryBySession，SessionCard 显示已失效旧 summary | ❌ | ✅ batch 1 | — |
| 7 | MED | HistoryPanel.tsx:41 | reload 没 sequence，旧筛选慢请求覆盖新结果 | ❌ | ✅ batch 1 | — |
| 8 | MED | PendingTab.tsx:90-152 | batchBusy 未透传给 row，并发 batch+单条响应撞 "request not found" | ❌ | ✅ batch 1 | — |
| 9 | MED | ImageBlobLoader.tsx:56 | 失败结果（`LoadImageBlobResult.ok=false`）永久缓存，同一图永远不重试 | ❌ | ✅ batch 2 | — |
| 10 | MED | sdk-injection.ts:116 | `saveUserAgentDeckClaudeMd` 用 `writeFileSync` 直接覆盖，崩溃/磁盘满会留半截文件 | ❌ | ✅ batch 3 | — |
| 11 | MED | cli.ts:88 | 字符串 flag 缺值被吞为 `true`，部分 flag 静默 fallback 让用户察觉不到错命令 | ❌ | ✅ batch 3 | — |
| 12 | MED | cli.ts:180 | codex-cli 忽略 permissionMode 但 cli 路径写入 DB（UI 已挡显示，仅 DB 列污染） | ❌ | ✅ batch 3 | — |
| 13 | MED | file-change-repo.ts:54 | `ORDER BY ts DESC` 缺 secondary key，同毫秒次序不稳 | ❌ | ✅ batch 3 | — |
| 14 | MED | main.tsx:92 | 噪音白名单漏 monaco `Canceled` 错误，偶发红屏 | ❌ | — | ✅ |
| 15 | LOW | use-event-bridge.ts:18 | 启动 `setSessions` 全量替换覆盖 await 期间收到的 `session-upserted` | ❌ | ⚠️ 降 LOW | — |
| 16 | LOW | session-store.ts:132 | `setSessions` 全量替换不 prune by-session 缓存，HMR 留 orphan | ❌ | ✅ batch 1 | — |
| 17 | LOW | file-change-repo.ts:24 | `JSON.parse(metadata_json)` 不 try/catch，单条坏数据炸全列表 | ❌ | ✅ batch 3 | — |
| 18 | LOW | PdfDiffRenderer.tsx | 注册了但是占位，PDF 文件 diff 一直显示「待实现」无说明 | ❌ | ✅ batch 2 | — |
| 19 | LOW | main.tsx:62 | unhandledrejection 一律 fatal banner 永久遮挡，瞬时异常打死整窗 | ❌ | ⚠️ 降 LOW | — |
| 20 | LOW | SummaryView.tsx:17 | 切会话 race（按 sessionId 分隔已挡，仅 UI 闪一次「暂无总结」） | ❌ | ⚠️ 降 LOW | — |

### ❌ 反驳

| 报告方 | 报项 | 反驳依据 |
|---|---|---|
| Claude A HIGH | ImageBlobLoader.tsx:76 eslint-disable 压制依赖 | sourceKey 是 source 序列化派生，eslint-disable 是 React 官方推荐姿势 |
| Claude A HIGH | ActivityFeed.tsx:96 pendingXxxIds Set 初始化 | Claude A 自己结论已写「实际安全」 |
| Claude A MED ×8 | ActivityFeed 依赖过宽 / SessionDetail useEffect 二次请求 / SummaryView 没 abort（已升 LOW 入清单 #20）/ PermissionsView refresh 死循环 / PendingTab useMemo 4 Map 依赖 / HistoryPanel debounce setTimeout / preload expose silent crash（升 LOW）等 | 多数为 React 默认行为或 Zustand 浅 immutable 的误读，无实际危害 |
| Claude A LOW ×3 | session-store setLatestSummaries orphan / FloatingFrame data-pinned Tailwind / preload electronIpc raw 暴露 | trivial 或对项目设计取舍误读（`window.electronIpc.invoke` 是 CLAUDE.md 第 84 行明示的有意兜底） |
| Codex B2 M3 | preload electronIpc raw 暴露绕过白名单 | 项目 CLAUDE.md 明示有意设计 |
| Codex B2 H2 | App.tsx:92 stickySelected fallback 错会话 | CHANGELOG_8 已知设计取舍，操作错会话概率极低（缓存与 selected 永远是同 id） |
| Codex B2 L1 | DiffViewer.tsx:26 sessionId 可选 | 现实 4 个调用点全传了 sessionId，无触发路径 |
| Codex B3 H4 | hook-installer.ts:43 POSIX shell 命令 Windows 不可执行 | 项目仅 macOS（CLAUDE.md 第 9 行明示） |

### ⚠️ 部分（双方角度不同 / 严重度被调整）

| 现场 | A 视角 | B 视角 | 结论 |
|---|---|---|---|
| SettingsDialog.tsx:32-37 catch 链拼接 | Claude A：HIGH（并发失败拼接错） | 现场核实并发失败概率极小 + 不影响功能 | 降 LOW，本轮不修 |
| App.tsx listAdapterPendingAll 硬编码 'claude-code' | Claude A：MED | 现场核实 codex-cli 暂无 pending，未来扩展才会漏 | 降 LOW，本轮不修（防御性可加） |
| SessionDetail listFileChanges race | Claude A：MED 二次请求 | Codex B1：HIGH 切会话 race；用户：HIGH 不订阅 file-changed | 三方合并到 #4，融合方案统一修 |
| use-event-bridge 启动 race | — | Codex B2：HIGH 窗口窄 | 现场核实 listSessions <50ms 窗口窄 → 降 LOW（仍修） |
| main.tsx unhandledrejection 一律 fatal | — | Codex B2：HIGH 太严 | 现场看是设计取舍但确实可改（fatal 自动消失而非永久遮挡）→ 降 LOW（仍修） |
| SummaryView 没 abort | Claude A：MED | Codex B2：MED race 误显示 | setLocal 按 sessionId 分隔已挡，仅闪一次 → 降 LOW（仍修） |

## 修复（CHANGELOG_18 落地）

20 条全修。完整代码见 CHANGELOG_18。

### HIGH

1. **hook-installer.ts:62-69, 99-125** — readSettings parse 失败抛错（不再回退 `{}` 后写回覆盖用户原配置）；status() 路径单独 try/catch 兜底为「未安装 + warn」避免 UI 卡死
2. **SettingsDialog.tsx:76 + ClaudeMdEditor** — 加 `claudeMdDirtyRef` + `guardedClose` 拦截关闭，子组件 useEffect 上报 dirty；卸载时显式重置防 ref 残留
3. **ActivityFeed.tsx:125** — 抽 `eventKey()`：tool-use 用 toolUseId、waiting-for-user 用 type+requestId、file-changed 用 ts+filePath、其余用 sessionId+kind+ts；头部插入新事件不再让所有 row 全 remount
4. **SessionDetail.tsx:90-103** — 融合方案：订阅 `agent-event` 'file-changed' + 300ms 节流（合并 MultiEdit 拆出的 N 条）+ sequence counter（防过期 IPC）+ disposed flag（防卸载）+ selection 保留逻辑（filePath/changeId 仍在新数据里则保留，否则 fallback 到 latest）

### MED

5. **SettingsDialog.tsx:312-341** — NumberInput 改 string 草稿 + blur/Enter 时 commit + clamp(min, max)，Escape 取消草稿；阻断 hookServerPort=0 这种"语义违法但 isFinite=true"的值落库
6. **session-store.ts:267-275** — setSummaries(空数组) 同步 `latestMap.delete(sessionId)`
7. **HistoryPanel.tsx:41-50** — 加 `reqIdRef` sequence counter，then 回调比较 `cur !== reqIdRef.current` 丢弃过期请求
8. **PendingTab.tsx:218** — `<ol>` 加 `pointer-events-none opacity-50` 当 batchBusy 时锁住 row（避免改三个 Row 的 props）
9. **ImageBlobLoader.tsx:56-72** — 仅 `result.ok===true` 才进 cache；失败结果不缓存，下次会重试
10. **sdk-injection.ts:115-126** — `saveUserAgentDeckClaudeMd` 改 atomic write（mkdir + write tmp + renameSync），与 hook-installer.writeSettings 同模式
11. **cli.ts:67-95** — `VALUE_REQUIRED_FLAGS` 集合 + 缺值时抛错（cwd/agent/prompt/model/permission-mode/resume）；handleCliArgv 已有 dialog.showErrorBox 兜底
12. **cli.ts:180** — 加 `if (adapter.capabilities.canSetPermissionMode)` 守卫；codex-cli 不再被污染 sessions.permission_mode 列
13. **file-change-repo.ts:54** — SQL 改 `ORDER BY ts DESC, id DESC`（自增 PK 单调，secondary key 稳定）
14. **main.tsx:87-95** — `isMonacoUnmountRaceNoise` 加双字段判定 `name === 'Canceled' && message === 'Canceled'`（对齐 monaco `isCancellationError`），不只看 message 防止误吞「Job was Canceled by user」类真错误

### LOW

15. **use-event-bridge.ts:16-50** — 调换顺序：先注册所有 listener 再 IIFE 拉快照；setSessions 已实现 prune + 同 id 内容覆盖语义，对 listener 已 upsert 的新会话不会丢
16. **session-store.ts:132-167** — setSessions 加 `validIds` 集合 + `prune` 工具函数遍历 7 张 by-session Map，删 orphan；selectedSessionId 不在新集合也清
17. **file-change-repo.ts:16-30** — rowToRecord 包 try/catch JSON.parse；失败回 `{}` + warn，单条坏数据不再炸全列表
18. **PdfDiffRenderer.tsx** — 标题改「PDF diff 暂不支持」+ 加说明「改动已记录在 file_changes 表里，未来支持后会自动展示」
19. **main.tsx:97-150** — fatal banner 加 `FATAL_AUTO_DISMISS_MS=8000` 自动消失（fade 400ms），手动 ✕ 仍然立刻关；统一 `remove()` 内 clearTimeout 防残留
20. **SummaryView.tsx:17-26** — 加 `aborted` flag + cleanup 设 true；卸载/换会话后旧 IPC then 不再 setState

## 关联 changelog

- [CHANGELOG_18.md](../changelog/CHANGELOG_18.md)：本次 20 处修复落地

## Agent 踩坑沉淀

本轮 review 没有提炼新的 agent-pitfall 候选——所有真问题（资源清理 / TOCTOU / 异步 race）都属于 REVIEW_1 已写入 CLAUDE.md「资源清理 & TOCTOU 防线」节的已知模式。本轮的 codex 独发率验证了「Claude 倾向把任意未做防御标 HIGH，未先检查项目设计取舍与现实触发路径」的模式，与 REVIEW_1 一致。
