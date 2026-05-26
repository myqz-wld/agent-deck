---
review_id: 4
reviewed_at: 2026-04-24
expired: false
skipped_expired: []
---

# REVIEW_4: origin/main..HEAD 双对抗（Phase 0-3 评审落地 + ActivityFeed 拆 8 文件 + 后端 5 新模块）

## 触发场景

用户主动触发：「code review 本地和远程 main 中间的改动」。本地 HEAD 比 origin/main 领先 2 个 commit：

- `22ca374` CHANGELOG_19：ActivityFeed 695 行拆 8 文件 + 顺手补初始化 race（含 6 候选对抗评估附录）
- `2adc4b7` CHANGELOG_20+21：双对抗架构评审 Phase 0-3 落地（settings 拆分 + 后端 payload-truncate / event-router / SDK bridge / 错误诊断 / 测试基建）

合计 40 文件 / +2807 / -1399 行。按 `~/.claude/CLAUDE.md`「已审文件过期」机制扫一遍：

- REVIEW_1 已审 6 文件全部未过期（churn 都没破 min(200, LOC×30%) 阈值，commits ≤ 2，2026-04-24 同日刚审）
- REVIEW_2 已审中 `SettingsDialog.tsx` churn=440 vs thresh=102 → **过期重审**；`ActivityFeed.tsx` 整文件被删拆，新路径按未审处理（CLAUDE.md「rename / move / split 不继承」）；其余 9 文件未过期
- REVIEW_3 与本批 commit 无文件交集

经用户确认，把「未过期但本批改动量大」的 `ipc.ts` (+164/177，接近阈值且新加多个 SettingsSet/Hook handler) 与 `manager.ts` (+89/126) 也并入强 review 范围。

最终 19 文件，分 3 批跑双对抗。

## 方法

**双对抗配对**（`~/.claude/CLAUDE.md`「决策对抗」节）：

- **Agent A**：Claude `general-purpose` subagent，**Opus 4.7 xhigh**，3 实例并发起一条消息内并发，挑刺型 prompt（每文件给文件:行号 + ≤2 行代码片段，禁止复述代码用途，自驳段列考虑过但反驳掉的）
- **Agent B**：外部 Codex CLI，**gpt-5.4 xhigh**（`codex exec --sandbox read-only --skip-git-repo-check -c model_reasoning_effort=xhigh`，`zsh -i -l -c` 包外层，`-o` 抓最终答案），3 实例后台并发，同主题 prompt 但更精简（只列文件清单 + 重点盲点）

**实际执行**：

- 6 任务并发起，全部 < 6 分钟收齐（codex 三批分别 ~3 / ~2 / ~3 分钟）
- 单 Agent stuck 风险已用 ≤8 文件 / ≤30 行 prompt 拆批化解（REVIEW_3 codex 卡 16 分钟教训），本轮 codex 全部按时返回，未触发降级
- 关键 ⚠️ 项现场用 Read/Grep 核实（rollback 路径 / TOCTOU stat→readFile / sdk-bridge timeout 双 emit / setRecentEvents 是否截断）

**3 批分组**：

```text
批 1 后端类（7 文件 ~2300 行）
  src/main/ipc.ts                                      （扩范围，+164/177 接近过期）
  src/main/session/manager.ts                          （扩范围，+89/126）
  src/main/adapters/codex-cli/sdk-bridge.ts            （新增 sdk-bridge 流式接管）
  src/main/notify/event-router.ts                      （新增事件路由）
  src/main/store/payload-truncate.ts + .test.ts        （新增 payload 截断 + 单测）
  src/main/session/__tests__/manager.test.ts           （新增 manager 单测）

批 2 settings 拆分（4 文件 ~820 行）
  src/renderer/components/SettingsDialog.tsx           （过期重审，churn=440 vs thresh=102）
  src/renderer/components/settings/ClaudeMdEditor.tsx  （新增）
  src/renderer/components/settings/SummarizerErrorsDiagnostic.tsx （新增）
  src/renderer/components/settings/controls.tsx        （新增）

批 3 activity-feed 拆分（8 文件 ~744 行，原 ActivityFeed.tsx 整文件删拆）
  src/renderer/components/activity-feed/index.tsx
  src/renderer/components/activity-feed/describe.ts
  src/renderer/components/activity-feed/format.ts
  src/renderer/components/activity-feed/shared.ts
  src/renderer/components/activity-feed/rows/{message,simple,thinking,tool}-row.tsx
```

**机器可读范围**（File-level Review Expiry 用；一行一个仓库相对路径，按字典序，无 glob）：

```review-scope
src/main/adapters/codex-cli/sdk-bridge.ts
src/main/ipc.ts
src/main/notify/event-router.ts
src/main/session/__tests__/manager.test.ts
src/main/session/manager.ts
src/main/store/payload-truncate.test.ts
src/main/store/payload-truncate.ts
src/renderer/components/SettingsDialog.tsx
src/renderer/components/activity-feed/describe.ts
src/renderer/components/activity-feed/format.ts
src/renderer/components/activity-feed/index.tsx
src/renderer/components/activity-feed/rows/message-row.tsx
src/renderer/components/activity-feed/rows/simple-row.tsx
src/renderer/components/activity-feed/rows/thinking-row.tsx
src/renderer/components/activity-feed/rows/tool-row.tsx
src/renderer/components/activity-feed/shared.ts
src/renderer/components/settings/ClaudeMdEditor.tsx
src/renderer/components/settings/SummarizerErrorsDiagnostic.tsx
src/renderer/components/settings/controls.tsx
src/renderer/stores/session-store.ts
```

> 第 20 项 `session-store.ts` 不在 commit 改动列表里，但本轮发现的 #4 HIGH 是 `activity-feed/index.tsx:53` 与 `session-store.ts:60,212` 协同 bug，把它也纳入覆盖基线避免下次「session-store 没审过」误算。本文件**首次加入 git** 的 commit 视为该批文件覆盖基线。

**约束**：本轮重点 commit 改动 + 已审过期 + split 后未审；REVIEW_1/2/3 已修过的不重列；输出按 HIGH/MED/LOW 分级。

## 三态裁决结果

### ✅ 真问题（双方独立提出 / 一方提出但现场核实成立）

#### HIGH（4 条）

| # | 文件:行号 | 问题 | A | B |
|---|---|---|---|---|
| H1 | `manager.ts:329-342` + `sdk-bridge.ts:271-292,498-499` | `delete()` 同步调 `sessionRepo.delete` 后 `closeSession` 异步 abort runTurnLoop，catch 走 `aborted=true → emit('finished', subtype:'interrupted')`，该 finished `source='sdk'` 不被 dedupOrClaim 跳过，ensureRecord 把已删 session 复活成 lifecycle:'active' activity:'finished' 的幽灵 record + 触发一次「Agent 完成」系统通知。`emit('finished', { ok: false, subtype: 'interrupted' })` / `if (existing) {...} const rec: SessionRecord = {...}; sessionRepo.upsert(rec); eventBus.emit('session-upserted', rec)` | ✅ HIGH（manager 视角） | ✅ HIGH（sdk-bridge 视角） |
| H2 | `ipc.ts:194-219` | SettingsSet 注释宣称「事务保护避免 DB 改了 / 运行时半生效」，实际 catch 只 `settingsStore.patch(rollback)` 回滚 DB，前面 `applyLifecycleThresholds` / `applyLoginItem` / `applyAlwaysOnTop` / `applyPermissionTimeout` / `applyCodexCliPath` / `applySummaryInterval` / `invalidateClaudeMdCache` 已经动了 scheduler / 登录项 / window.alwaysOnTop / adapter 实例 / Codex 实例 / cache，任一后续 apply 抛错正好留在「DB 回滚 + 运行时半生效」状态。`} catch (err) { ... settingsStore.patch(rollback); throw err; }` | ✅ HIGH | — |
| H3 | `payload-truncate.ts:14-15,25-28,41-51,86-90` | 阈值 `MAX_PAYLOAD_BYTES=256K` / `MAX_FIELD_BYTES=8K` 全用 `string.length`（UTF-16 code units），emoji / 中文 toolResult 实际 UTF-8 字节最高可达声明 3 倍（256KB 实际可写 ~768KB）；`truncateString` `s.slice(0, max)` 正好切到 surrogate pair 中间会切出孤儿 high surrogate，下游 JSON.parse 不报错但 UI 渲染替换字符；KNOWN_LARGE 数组分支只看 `el.text` 不递归 `el.content`，Claude tool_result 真实结构 `{type:'tool_result', content:[{type:'text', text:'...'}]}` 外层逃逸；`safeTruncateBlob` 对 JSON / dataURL 直接尾切拼 sentinel 破坏结构。`if (s.length <= max) return s; ... if (raw.length <= MAX_PAYLOAD_BYTES) return raw;` / `return blob.slice(0, MAX_PAYLOAD_BYTES) + ...` | ✅ HIGH+MED 多点 | ✅ HIGH+MED 多点 |
| H4 | `activity-feed/index.tsx:53` + `session-store.ts:60,212,317-321` | 初始 `listEvents(sessionId, 100)` → `setRecentEvents` 直接 `m.set(sessionId, events)` **不截断**到 100 条；pushEvent 用 `RECENT_LIMIT=30` 截 `[event, ...arr].slice(0, 30)`。结果：用户切到一个有 100 条历史的会话刚渲染完，下一条事件来 70 条历史从 UI 蒸发。`void window.api.listEvents(sessionId, 100).then(...)` / `const next = [event, ...arr].slice(0, RECENT_LIMIT);` | ✅ HIGH | — |

#### MED（17 条）

| # | 文件:行号 | 问题 | A | B |
|---|---|---|---|---|
| M1 | `ipc.ts:140-148, 167-171` | `Number(limit ?? 200)` 对 `'foo'` 返回 NaN 直接进 SQLite LIMIT；`ids` 数组无 size 限制；renderer 可一次性请求全表。`return eventRepo.listForSession(String(id), Number(limit ?? 200));` | ✅ MED | ✅ LOW |
| M2 | `ipc.ts:174-187` | HookInstall / HookUninstall / HookStatus 把 `scope`/`cwd` 直接 `as 'user' \| 'project'` / `as string` 强转下传，IPC 层枚举 + 路径完全没收口。`adapter.uninstallIntegration({ scope: scope as 'user' \| 'project', cwd: cwd as string });` | — | ✅ MED |
| M3 | `ipc.ts:231-247` | AdapterCreateSession 对 `opts.permissionMode` 字段无白名单校验，renderer 可塞 `'rm -rf'` 字符串直接进 `recordCreatedPermissionMode` 写库；`o.cwd = homedir()` 对 null/undefined 直接 TypeError。`if (!o.cwd \|\| !String(o.cwd).trim()) { o.cwd = homedir(); }` | ✅ MED | — |
| M4 | `sdk-bridge.ts:13,162-186` | 首条 `prompt` 只校验非空就进 `pendingMessages` 队列，`MAX_MESSAGE_BYTES = 100_000` 上限只对后续 `sendMessage()` 生效；用户从 NewSessionDialog 粘 100MB 文本会直接走流。`const MAX_MESSAGE_BYTES = 100_000` / `pendingMessages: [opts.prompt]` | — | ✅ MED |
| M5 | `sdk-bridge.ts:383-393,498-499` | 30s timeout 路径 `internal.currentTurn?.abort()` + `resolveWithFallback` 走 `'finished' subtype:'error'`，runTurnLoop 的 catch 在 `aborted=true` 时**再** emit `'finished' subtype:'interrupted'`，UI 收 2 条 finished + 2 次系统通知。`internal.currentTurn?.abort(); resolveWithFallback(...)` / `if (aborted) { emit('finished', ...); }` | — | ✅ MED |
| M6 | `event-router.ts:12-40` | 整函数无 try/catch，`notifyUser` 内 `new Notification(...).show()` / `app.dock?.bounce()` / playSoundOnce 任一抛错（macOS 无通知权限 / Notification.isSupported 误判 / dock 已 release）会冒泡到 adapter 的 for-await emit 循环，把后续事件流整条切断。`notifyUser({ title: 'Agent 等待你的输入', body: ..., level: 'waiting' });` | ✅ MED | — |
| M7 | `event-router.ts:32-38` | `finished` 不看 `payload.ok/subtype`，error / interrupted 也统一标题「Agent 完成」。配合 H1（删除复活）+ M5（双 finished）让用户看到莫名的「完成」通知。`if (event.kind === 'finished') {` / `title: 'Agent 完成'` | — | ✅ MED |
| M8 | `SettingsDialog.tsx:42,140` | `getSettings` 失败后只 `setLoadError`，`!settings` 永真，`SettingsBody` 永不渲染，dialog 卡 "读取设置中…"（错误能看到，但表单完全不能用，重开 dialog 才能恢复）。`catch((err: unknown) => setLoadError(...))` / `{!settings ? <div ...>读取设置中…</div> : <SettingsBody ... />}` | — | ✅ MED |
| M9 | `SettingsDialog.tsx:31-55, 80` | `useEffect` 无 cleanup / abort flag，弹窗快速切换时旧打开的 IPC 返回值会污染新打开的 state；`update()` 既不串行也不丢弃过期响应，连点多个 toggle 时慢响应回写旧值。`void window.api.getSettings().then(...)` / `const next = (await window.api.setSettings(patch)) as AppSettings; setSettings(next);` | ✅ LOW | ✅ MED |
| M10 | `ClaudeMdEditor.tsx:23,53-66` | save 没有 mtime / version 冲突检测，外部进程 / 另一窗口在编辑期间改了 `~/.claude/CLAUDE.md` / userData 副本会被本地 draft 静默覆盖，无 conflict 提示。`useState<{ content: string; isCustom: boolean } \| null>(null)` / `await window.api.saveClaudeMd(draft); setLoaded({ content: draft, isCustom: true });` | ✅ MED | ✅ HIGH |
| M11 | `ClaudeMdEditor.tsx:48-51,59` + `SettingsDialog.tsx:150-152` | save 后 `setLoaded({ content: draft, isCustom: true })` 用本地 draft 而非 main 写盘后实际内容（main 端规范化 BOM / CRLF→LF / 末尾补 `\n` 后下次 dirty 永真，「保存」按钮一直亮但 IPC 没东西可写）；`onClaudeMdDirtyChange` 用内联箭头每次父级 rerender 都换 identity，child `useEffect(..., [dirty, onDirtyChange])` cleanup→run 把 ref 先置 false 再置 dirty，cleanup 里发伪 false。`onClaudeMdDirtyChange={(d) => { claudeMdDirtyRef.current = d; }}` / `return () => onDirtyChange?.(false)` | ✅ MED | ✅ MED |
| M12 | `controls.tsx:70-86` | NumberInput `useEffect(() => { if (!editing) setDraft(String(value)); }, [value, editing])` 在 commit→`setEditing(false)` 触发时立刻跑一次：此瞬间 value prop 还是旧值（parent async update 未回流），把刚 setDraft clamped 回退到旧值，parent IPC 慢一点能看到 "输入 1500 → 闪 900 → 变 1500" flicker。`useEffect(() => { if (!editing) setDraft(String(value)); }, [value, editing]);` | ✅ MED | — |
| M13 | `controls.tsx:76-86` + `SettingsDialog.tsx:284-294,309-315` | `Number(draft)` 接受小数，`1.5` 直接流进 `summaryEventCount` / `summaryMaxConcurrent` / `historyRetentionDays` / `hookServerPort` 这些语义为整数的设置；HTML number step=1 不强制 integer，JS 也没 `Math.trunc` / `Number.isInteger` 校验。`const n = Number(draft); ...if (clamped !== value) onChange(clamped);` | ✅ MED | ✅ MED |
| M14 | `activity-feed/index.tsx:78-80,86-97,148` | render 里每次新建 `pendingPermIds` / `cancelledPermIds` Set + for 全表扫；`ActivityRow` 未 `React.memo`（即便 memo props 引用每次都变也失效），千级事件每次 pushEvent 整列全重渲。`const pendingPermIds = new Set(pendingPermissions.map((r) => r.requestId));` / `for (const e of recent) { ... }` | ✅ MED | ✅ MED |
| M15 | `activity-feed/rows/tool-row.tsx:84,86,89` | 每次 ToolEndRow re-render 都重新 `formatToolResult` (含 JSON.stringify) + `parseImageReadResult` (含 JSON.parse) 即便 open=false 闭合状态也付费。`const text = formatToolResult(result); const imageRead = parseImageReadResult(result);` | ✅ MED | ✅ MED |
| M16 | `activity-feed/rows/{thinking,message}-row.tsx:49-63,62-82` | 单条 thinking / message 文本无 max-height / 折叠，Claude extended thinking 几十 KB 直接 inline 渲染（MD 模式还要全文 ReactMarkdown 解析）。`<div className="break-words rounded-lg ... whitespace-pre-wrap">{text...}</div>` | ✅ MED | ✅ MED |
| M17 | `activity-feed/rows/tool-row.tsx:61-65` | Edit / Write / MultiEdit 的 `tool-use-start` 直接挂 DiffViewer（可能解出 Monaco），多条 Edit 同窗口 → 多份重渲染器同时 mount，没 click-to-expand 懒挂载。`{diff && (<div className="mt-1 h-72 ..."><DiffViewer payload={diff} sessionId={sessionId} /></div>)}` | ✅ LOW | ✅ MED |
| M18 | `activity-feed/index.tsx:53` | `void window.api.listEvents(sessionId, 100).then(...)` 无 `.catch`，IPC reject 时 `setLoaded(true)` 永不执行，feed 卡死在加载态。`void window.api.listEvents(sessionId, 100).then((events) => { ... setLoaded(true); });` | — | ✅ MED |
| M19 | `format.ts:29` | `eventKey` fallback `${sessionId}:${kind}:${ts}` 同 session 同 kind 同毫秒撞 key（SDK 同毫秒发 message + thinking 不少见，message+message 也可能），React 复用错 row 的 useState（MD/TXT, ▾/▸）。`return \`${e.sessionId}:${e.kind}:${e.ts}\`;` | ✅ LOW | ✅ HIGH |

#### LOW（9 条，归档跟踪不必都修）

| # | 文件:行号 | 问题 | 报告方 |
|---|---|---|---|
| L1 | `activity-feed/index.tsx:104` | `<ol>` 缺 `role="log"` / `aria-live="polite"`，事件流式推入屏阅器静默 | A MED + B LOW |
| L2 | `SettingsDialog.tsx:115-126,119` | modal 缺 ESC 关闭、缺 backdrop 点击关闭、缺 `role="dialog"` / `aria-modal` / focus trap，`✕` 按钮无 aria-label | A MED + B LOW |
| L3 | `ClaudeMdEditor.tsx:37,62,90` | main 抛错原文带绝对路径直接渲染 UI（如 `ENOENT: no such file '/Users/.../.claude/CLAUDE.md'`） | A LOW + B MED |
| L4 | `activity-feed/shared.ts:32` | `EMPTY_EVENTS: AgentEvent[] = []` 暴露可变数组，消费方误 push 即污染所有会话兜底引用 | A LOW |
| L5 | `activity-feed/describe.ts:9,28,5-37` | `cwd ?? ''` 留尾随 " · "；`p.message as string` 对象会变 `[object Object]`；default 显示原始 kind 字符串 | A LOW |
| L6 | `controls.tsx:248,129` | `(err as Error).message` 没 `?? String(err)` 兜底，非 Error throw 渲染 "失败：undefined"；`path.split('/')` 假设 POSIX（macOS-only 当下 OK） | A LOW |
| L7 | `payload-truncate.test.ts:1-84` | 测试缺 utf-8 / surrogate 边界、非 KNOWN_LARGE 超长字段、payload 是字符串/数组形态、`safeTruncateBlob` 等于阈值边界、`__keys` 长度上界 | A LOW + B LOW |
| L8 | `manager.test.ts` | 公共 API（`archive` / `unarchive` / `delete` / `markDormant` / `markClosed` / `reactivate` / `renameSdkSession` / `recordCreatedPermissionMode`）一行未测；beforeEach 只 release 硬编码 id 列表，pendingSdkCwds Map 永不清；H1 幽灵 session 场景没回归测 | A LOW + B LOW |
| L9 | `sdk-bridge.ts:134-140`、`manager.ts:165-180`、`ipc.ts:540-554` | setCodexCliPath 仅 trim 不校验 path 存在 / 可执行 / 白名单（A LOW，自驳后保留）；dedupOrClaim `source==='hook'` 严格判定缺 source 字段绕过去重（A 自驳后 LOW）；image stat→readFile 之间路径可被替换（B MED，桌面单用户场景降 LOW） | A LOW × 2 + B MED |

### ❌ 反驳（被对抗或现场核实证伪）

| 报告方 | 报项 | 反驳依据 |
|---|---|---|
| Codex B | `ipc.ts:509` `startsWith('/')` 假设 POSIX 拒 Windows `C:\...` | 项目 macOS-only（CLAUDE.md「仓库基础」/ package.json `build.mac` 是唯一 target），Windows 路径不在 scope |
| Codex B | `manager.ts:251,404` session-end 只改 lifecycle 不改 activity，`closed/dormant` 会话停 working/waiting | 设计取舍（lifecycle 与 activity **正交**，CHANGELOG 早期决策；activity = 「最近活跃度快照」，UI 上保留「会话结束时最后一刻状态」是有意为之，不是 bug） |
| Claude A 自驳 | `event-router.ts` async listener 被吞 | visual.ts notifyUser 全 sync 实现，路径上无 `emitter.on(async ...)`；M6 的真问题不是 async 吞错而是 sync throw 冒泡，定位修正 |
| Claude A 自驳 | manager.ts cwdById 全局 fuzzy / realpath 倒退 | manager.ts:15-20 `realpathSync(resolvePath(cwd))` 仍在，consumePendingSdkClaim 没有「全局 fuzzy 匹配」（CHANGELOG_16 / REVIEW_1 修复未倒退） |
| Claude A 自驳 | ON DELETE CASCADE 不会触发 events_ad（REVIEW_3 复用结论） | sqlite3 3.43.2 实测确认 CASCADE 真会触发 AFTER DELETE 触发器（REVIEW_3 verify-fts5.sh #10 已 guard） |
| Claude A 自驳 | `consumePendingSdkClaim` 过期分支无内存泄漏 | 现场看有 `delete pendingSdkCwds.get(cwd)`，自驳成立 |
| Claude A 自驳 | `runTurnLoop` 早期 error break 前漏清 currentTurn / turnLoopRunning | 现场 finally 复位，资源清理完整 |
| Codex B 自驳 | `ipc.ts:205-207` hookServerPort/hookServerToken 漏分发 | 该处显式有 warnHookServerPort / warnHookServerToken 调用，自驳成立 |
| Codex B 自驳 | `describe.ts` / `format.ts` 副作用 / 循环依赖 | 现场只字符串处理 + JSON.parse，shared 单向 import |

### ⚠️ 部分（双方都看到现场但角度不同）

| 现场 | A 视角 | B 视角 | 结论 |
|---|---|---|---|
| `activity-feed/index.tsx` 没把 `file-changed` 特化分发到 ImageDiffRenderer | 没特别报 | Codex MED：dispatcher 漏分支兜底 SimpleRow | tool-row.tsx:71 注释明示「file-changed → ImageDiffRenderer 接管」是指 diff tab 接管，活动流仍走 SimpleRow 显示 "📝 ${filePath}"。**设计取舍非 bug**，归档不修 |
| SettingsDialog 拆出 controls.tsx 通用 props 类型严格性 | Claude LOW：未导出类型可能影响复用 | 没特别报 | 当前唯一消费者就是 SettingsDialog，未导出无影响。**暂不动**，将来若被外部引用再补 export type |

## 修复建议（按严重度，**等待用户决定哪些落地到下一份 CHANGELOG**）

> 本份 review 不预置 CHANGELOG 编号。HIGH 4 条强烈建议落地；MED 17 条建议大部分修但有取舍空间；LOW 9 条按精力选修，多数可归档跟踪。

### HIGH（4 条，必修）

1. **H1 manager.ts:329-342 + sdk-bridge.ts** — 删 session 时先 await closeSession 再 sessionRepo.delete；或者在 ensureRecord 加「记忆已删除 sessionId 黑名单」短窗口（5s）丢弃尾包；二选一。建议前者更彻底
2. **H2 ipc.ts:194-219** — catch 里要么也跑一遍 apply* 链回滚（按 patch 影响范围反向应用 before 值），要么把 apply* 链改成「全部成功才 patch」（先 dry-run 验证，再 patch + apply）。后者更彻底
3. **H3 payload-truncate.ts** — 改字节计算（`Buffer.byteLength(s, 'utf8')`）+ utf-8 安全切（找到 ≤ max 的最后一个 code point 边界）+ KNOWN_LARGE 递归 `el.content`；`safeTruncateBlob` 改成「整体丢弃保留前 N KB 标 marker」而非破坏结构
4. **H4 session-store.ts + activity-feed/index.tsx** — 二选一：(a) `setRecentEvents` 里 `events.slice(0, RECENT_LIMIT)`；(b) 把 `RECENT_LIMIT` 提到 100 与 listEvents 对齐；(c) 拆「初始 100 条全保留 + push 后只截到 100」。建议 (a) 最小改动，或者顺手把 RECENT_LIMIT 提到 200 撑长会话浏览体验

### MED（17 条，建议落地大多数）

按主题分组方便决策：

**SDK / 主进程数据完整性（M1-M7）**

- M1-M3 IPC handler 输入校验：抽 `validators.ts` 集中收口（permissionMode 白名单、limit 上下界、scope 枚举、cwd 路径校验）
- M4 sdk-bridge 首条 prompt 也走 `MAX_MESSAGE_BYTES` 校验
- M5 timeout + abort 双 finished：在 resolveWithFallback 里立 `finishedEmitted=true` 标记，runTurnLoop catch 看到标记就跳过
- M6 event-router 整段包 try/catch，notifyUser 抛错只 console.error 不冒泡
- M7 finished 区分 ok/subtype：subtype=interrupted/error 走「Agent 中断 / 出错」标题

**Settings / Renderer（M8-M13）**

- M8 SettingsDialog getSettings 失败给「重试」按钮 + DEFAULT_SETTINGS 兜底渲染
- M9 加 abort flag + 串行化 update（debounce / queue）
- M10 ClaudeMdEditor save 前传 `expectedMtime`，main 端比对失败返回 conflict 让 UI 提示
- M11 save 后用 main 返回的实际写盘内容更新 loaded（main saveClaudeMd 改返回 `{content, mtime}`）；`onClaudeMdDirtyChange` parent 用 `useCallback` 稳定 identity，去掉 cleanup 里的伪 false
- M12 NumberInput 改 commit 路径直接 `setDraft(String(clamped))` 而非 effect 同步；或者 effect 改条件「!editing && draft != value」防回弹
- M13 NumberInput 加 `integer?: boolean` prop，整数项加 `Math.trunc` + `Number.isInteger` 校验

**Activity Feed 性能（M14-M19）**

- M14 `ActivityRow` 包 `React.memo` + 每 row 改用 props.has(eventId) 而非 Set 引用；pendingPermIds/cancelledPermIds 用 useMemo 锁定到 [pendingPermissions, recent]；或者 cancelled* 直接放 store 派生
- M15 ToolEndRow 把 formatToolResult/parseImageReadResult 包 useMemo([result])；或 open=false 时不算
- M16 thinking/message 加 max-height + 「展开全文」按钮；超过 N KB 默认折叠
- M17 DiffViewer 改 click-to-expand（默认显示 file_path 占位）
- M18 listEvents `.then(...)` 加 `.catch(setLoaded(true) + setError)` 让 feed 进可恢复错误态
- M19 eventKey fallback 加随机 nonce 或事件序号；message/thinking 也用 toolUseId 类似的稳定 id 做 key

### LOW（9 条，按精力选修）

L1-L9 大多归档跟踪，单独看 ROI 较低；建议至少修：

- L4 `EMPTY_EVENTS` 改 `as const` + `Object.freeze`（一行改动防御未来误 push）
- L7 / L8 测试覆盖补：H1 / M5 / M11 / payload-truncate utf-8 边界 都需要回归测，避免下次倒退

其他 a11y / 错误信息脱敏 / POSIX 假设留待后续统一处理。

## 关联 changelog

- [CHANGELOG_23.md](../changelog/CHANGELOG_23.md)：本份 review 修复落地（H1-H4 全 + M1-M19 全 + L4/L7/L8/L9 选改）

## Agent 踩坑沉淀

本次 review 抓出 1 条新模式化坑值得记入 `.claude/conventions-tally.md`「Agent 踩坑候选」section：

- **「字节阈值用 string.length 比较」会让 UTF-8 多字节内容突破声明上限**：H3 的 payload-truncate 已踩。同类陷阱在 SQL 字段长度 / 网络协议 length-prefix / 文件名长度限制等场景都会复现。修法：涉及「字节预算」的任何地方一律 `Buffer.byteLength(s, 'utf8')`，永不混用 `s.length`。下次类似场景（任何与「字节」相关的阈值用 `string.length`）撞 2 次再升级到 CLAUDE.md
