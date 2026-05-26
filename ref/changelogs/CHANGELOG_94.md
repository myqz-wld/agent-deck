# CHANGELOG_94: Phase 5 — A cross-session UI 渲染区分 + L SessionCard 增强 + M 透明 / 置顶解耦（plan mcp-bug-and-feature-batch-20260513 Phase 5）

**plan**: mcp-bug-and-feature-batch-20260513 Phase 5 Step 5.1-5.6（A + L + M 三模块；Step 5.5 dev smoke 推迟到 Phase 6 H6）

## 概要

Phase 5 收口三模块 — 一个 phase 一份 CHANGELOG（plan §决策 7 commit 节奏 (a)+(b)+(c) 一文 3 commit 模式）：

- **A cross-session UI 渲染区分**（Step 5.1+5.2 / commit `cdb2f87`）：renderer 端 parse universal-message-watcher 注入的 wire prefix `[from X @ Y][msg Z]` + chip 区分「自己输入」vs「跨会话注入」+ SessionDetail 加 messages tab 展示 messages 表中本 session 涉及的所有 send/reply（J fix 后 reply 不再 inject 给 sender SDK 后的 DB 视角兜底）
- **L SessionCard formatEventLine 增强 + 多行 live activity**（Step 5.3+5.4 / commit `cdb46d1`）：5 个 tool case 增强（TodoWrite 进度 / WebSearch query / WebFetch url / Task+Agent subagent）+ describeLiveActivity 返回数组最多 3 行（信息密度 3x）+ useMemo 缓存防 SessionList 滚动重算
- **M 透明 / 置顶解耦**（Step 5.6 / 本 commit）：settings 字段 `transparentWhenPinned` → `windowTransparent` 重命名 + 一次性 migration（旧值 → 新字段不丢用户偏好）+ window.ts vibrancy 不再依赖 alwaysOnTopCurrent + WindowSection.tsx 文案更新；用户追加 H1 中提「已有独立快捷键 Cmd+Alt+T，绑定 pin 不再合理」

合 3 atomic commit + 本 CHANGELOG。typecheck 双端通过 + 全 vitest 27 文件 394 it 通过 + 56 skipped（base 26 文件 385 it + 9 新 wire-prefix it + agent-deck-repos listBySession test 跟 SQLite binding 同 skip pattern）。

## 变更内容

### A. cross-session UI 渲染区分（Step 5.1+5.2）

#### A1. `src/shared/wire-prefix.ts`（新, ~50 LOC）

`parseWirePrefix(text)` helper 与 main 端 `universal-message-watcher.buildWireBody` 形式对称：

```ts
export interface WirePrefixParse {
  from: string;        // displayName
  adapter: string;     // claude-code / codex-cli / aider / generic-pty
  msgId?: string;      // B7+ format 必带；老 events 可能缺
  body: string;        // 去掉 prefix 的真正消息
}
const WIRE_PREFIX_RE = /^\[from ([^\]]+) @ ([^\]]+)\](?:\[msg ([^\]]+)\])?\n/;
```

regex 安全性：`[^\]]+` 防 displayName 含 `]` 导致贪婪越界（buildWireBody 不会写入 `]` 但防御性匹配）。startsWith fast-path 短路提速。

#### A2. `src/shared/__tests__/wire-prefix.test.ts`（新, 9 it 全过）

happy path（B7+ format with msgId）+ 老 prefix（无 msgId 兼容）+ 普通 user input（regex 不匹配）+ 空字符串 / 非字符串 null safety + 无 trailing `\n` 不匹配 + 多行 body 完整保留 + displayName 含中文/空格/CJK 标点 + 前导空格不允许（strict 起点）+ fallback `<adapter>:<sid 前 8>` displayName 格式。

#### A3. `src/renderer/components/activity-feed/rows/message-row.tsx`

- 仅 `role === 'user'` 时尝试 parseWirePrefix —— teammate 收 lead send_message → adapter.receiveTeammateMessage → sendMessage → emit role='user' 才有 prefix
- `text = (wirePrefix?.body ?? rawText).trim()` —— 后续渲染 / collapse 阈值 / MD-TXT toggle 都基于 body 而非含 prefix 的 rawText
- header 加 cyan chip：`bg-cyan-500/15 text-cyan-300`（与 lead 蓝、teammate 蓝、team 紫区分），label `↩ <displayName>`，max-width 12rem truncate；hover title 完整 `来自 <displayName> @ <adapter> · msg <msgId>`

#### A4. `src/main/store/agent-deck-message-repo.ts`

加 `listBySession(sessionId, opts?)`：SQL `WHERE from_session_id = ? OR to_session_id = ? ORDER BY sent_at DESC LIMIT ? OFFSET ?`，含 status 过滤分支（与 listByTeam 同 pattern）。注释说明不走部分索引（两谓词无法都索引），扫表 + WHERE filter 行数 ≤ 几千问题不大；agentDeckMessageRepo facade 同步透传。

#### A5. `src/shared/ipc-channels.ts` + `src/main/ipc/teams.ts` + `src/preload/index.ts`

- `IpcInvoke.AgentDeckMessageListBySession: 'agent-deck-message:list-by-session'` 新 channel
- ipc handler 校验 sessionId + limit/offset 跟 listByTeam handler 同 pattern（parseId / Math.min(limit, 500) / Math.max(offset, 0)）
- preload `listAgentDeckMessagesBySession({sessionId, limit?, offset?})` facade

#### A6. `src/renderer/components/SessionDetail/MessagesPanel.tsx`（新, ~120 LOC）

参考 TeamDetail/MessagesSection 风格：
- useEffect 拉 listAgentDeckMessagesBySession + 监听 onAgentDeckMessageChanged 200ms 节流后整体重拉（不解析 payload from/to，开销 ≤ 100 行 SQL 可接受）
- disposed flag + req sequence counter 防卸载 / 切会话 / 过期 IPC 污染
- 区分 sender/receiver：`isSender = msg.fromSessionId === sessionId` → 显示 `→ otherTitle` cyan 箭头；否则 `↩ otherTitle` blue 箭头
- reply chain：`msg.replyToMessageId` 非空时显示「↩ #abc12345…」chip
- 状态 + 相对时间 + body MarkdownText（与 MessagesSection 同视觉规范）

#### A7. `src/renderer/components/SessionDetail/index.tsx`

- Tab type `'activity' | 'diff' | 'summary' | 'permissions'` → 加 `'messages'`
- nav 加按钮 label「跨会话」（区别 messages 词在中文场景过宽）
- render 切换：`{tab === 'messages' && <MessagesPanel sessionId={session.id} />}`

#### A8. `src/main/store/__tests__/agent-deck-repos.test.ts`

加 1 it `listBySession 按 from_session_id OR to_session_id + sentAt DESC`：3 条 m1(sA→sB) / m2(sB→sC) / m3(sC→sA) 验证 sB 视角拿 m1+m2（DESC）+ m3 不命中 + status 过滤生效 + limit 透传 + 不存在 session 返回空。文件整体跟 SQLite binding 同 skip pattern（其它 28 it 也 skip），typecheck 兜底类型签名。

### B. L SessionCard formatEventLine 增强 + 多行 live activity（Step 5.3+5.4）

#### B1. summariseToolInput 5 个新 / 增强 case（`src/renderer/components/SessionCard.tsx`）

| Tool | 原 | 新 |
|------|----|----|
| TodoWrite | `return null` | `[N/M done] · activeForm`（done 数 + 当前 in_progress 摘要 40 字） |
| WebSearch | default fallback | `"abc..."`（query 截 50 字） |
| WebFetch | default fallback | url 截 60 字 |
| Task / Agent | default fallback | `subagent_type · description`（subagent_type 必有，description 截 40 字） |

新 case 注释引用 plan §决策 4 L2 + 与 activity-feed/describe.ts Skill case 同源逻辑保持一致（Skill case 已存在，未改）。

#### B2. describeLiveActivity 返回 string[] 最多 3 行

签名变化：`(session, recent): string | null` → `(session, recent): string[]`：

- waiting / finished 仍单行 special status（数组长度 1）
- 否则 cycle `recent.slice(0, 12)` 取最多 3 个 distinct line：去重连续同行（避免「Edit foo.ts × 5」刷屏）+ break 上限

#### B3. SessionCard render 多行结构

- liveLine 单 div → `liveLines.map((line, i) => ...)` 多行 truncate
- 视觉分层：i=0 主色 `text-deck-text/85`（最近一条），i≥1 副色 `text-deck-text/60`（更早）
- key `${i}-${line}` 避免行内容相同导致 React reuse 错位
- useMemo `[session, recent]` 缓存防 SessionList 滚动时无关 props 重渲算（plan §已知踩坑「L SessionCard 大改影响 SessionList 滚动性能」对应）

### C. M 透明 / 置顶解耦（Step 5.6）

用户追加 H1 中提：透明独立快捷键 `Cmd+Alt+T`（CHANGELOG_75）已上线后，再绑定 pin 不合理 —— 用户应该能「不 pin + 透明」或「pin + 不透明」。

#### C1. `src/shared/types/settings.ts`

- `transparentWhenPinned: boolean` → `windowTransparent: boolean`（DEFAULT_SETTINGS 同 true 兼容历史行为）
- jsdoc 改写：原「pin 时是否同步关闭 vibrancy」→ 「窗口是否启用透明效果，独立于 alwaysOnTop」+ 列举四种合法组合（pin+透/pin+不透/不pin+透/不pin+不透）

#### C2. `src/main/store/settings-store.ts`

- `REMOVED_KEYS` 加 `'transparentWhenPinned'`（自动清理孤儿字段）
- 一次性 migration：在 ensure() init 阶段 REMOVED_KEYS delete 循环之前，检测 `'transparentWhenPinned' in raw && !('windowTransparent' in raw)` → 把旧 boolean 值 set 给新字段（不丢用户偏好）；console.log 透明记录迁移

#### C3. `src/main/window.ts`

- `private transparentWhenPinned = true` → `private windowTransparent = true`（jsdoc 注明解耦动机）
- **删 `private alwaysOnTopCurrent = true`**（原本 setVibrancy 依赖此判断，解耦后不再读 → typecheck `TS6133 declared but never read` 强制清理）
- `setVibrancy(value && this.transparentWhenPinned ? null : 'under-window')` → `setVibrancy(this.windowTransparent ? null : 'under-window')`：vibrancy 仅由透明字段决定不再 && pin
- `setTransparentWhenPinned(value)` → `setWindowTransparent(value)`：内部不再 if `alwaysOnTopCurrent` 判断，直接应用 vibrancy（解耦后无论 pin 不 pin 都立即生效）

#### C4. `src/main/index.ts`

- bootstrap `floating.setTransparentWhenPinned(settings.transparentWhenPinned)` → `floating.setWindowTransparent(settings.windowTransparent)`
- `Cmd+Alt+T` shortcut handler：`settingsStore.get('transparentWhenPinned')` → `settingsStore.get('windowTransparent')` + `floating.setTransparentWhenPinned` → `floating.setWindowTransparent`

#### C5. `src/main/ipc/settings.ts`

- 函数 `applyTransparentWhenPinned` → `applyWindowTransparent`：`'transparentWhenPinned' in p` → `'windowTransparent' in p` + 调 `setWindowTransparent`
- APPLY_FNS 数组同步换名

#### C6. `src/renderer/App.tsx`

- state `transparentWhenPinned` → `windowTransparent`（注释引用 plan）
- 初始化 useEffect：`setTransparentWhenPinned(settings.transparentWhenPinned)` → `setWindowTransparent(settings.windowTransparent)`
- onTransparentToggled listener：同步 state + setSettings 用新字段名
- `<FloatingFrame transparent={pinned && transparentWhenPinned}>` → `<FloatingFrame transparent={windowTransparent}>` —— 解耦后不再 && pinned
- SettingsDialog onClose re-fetch settings 同步用新字段名

#### C7. `src/renderer/components/settings/sections/WindowSection.tsx`

- Toggle label「置顶时透明」→「窗口透明（看到下层桌面）」
- 文案更新：明示解耦含义 + 提示快捷键 `Cmd+Alt+T`
- 字段 `settings.transparentWhenPinned` → `settings.windowTransparent`，`update({transparentWhenPinned: v})` → `update({windowTransparent: v})`

#### C8. `src/renderer/components/FloatingFrame.tsx` + `src/renderer/styles/globals.css`

注释更新（jsdoc + CSS comment 都说「由 App.tsx 算 (pinned && transparentWhenPinned)」是历史逻辑，现在是 windowTransparent 单字段决定）。

## 测试

- typecheck 双端通过
- vitest 27 文件 394 it 通过 + 56 skipped（base 26 文件 385 it + 9 新 wire-prefix）
- A: 9 新 it 单测覆盖 wire-prefix parser 核心边界（happy / 旧格式 / 普通 input / null safety / 多行 / 中文 displayName / fallback 格式 / strict 起点）
- L: 纯 renderer 改动无单测，靠 typecheck（数组返回类型变化）+ Phase 6 dev smoke 验证
- M: settings migration / vibrancy 切换 / 快捷键独立 都靠 Phase 6 dev smoke 验证（typecheck 兜底字段名重命名）

## 用户决策（plan §决策 4-6 已确认事项）

| 决策 | 拍板 |
|------|------|
| §决策 5 A 实现方案 | 方案 B wire prefix renderer parse + chip（最小侵入；historical events 同有 prefix 无 P28 problem） |
| §决策 4 L 增强方向 | 已结论无 OPEN：5 个 tool case + 多行 live activity，不做 L3 popover |
| §决策 6 I sdkOwned 真私有 | 已在 Phase 3 完成（CHANGELOG_89） |

## 已知踩坑

- **listBySession 不走部分索引**：from OR to 两谓词无法都索引；扫表 + WHERE filter 行数 ≤ 几千 OK。如果未来 messages 表行数爆炸（>100k）需考虑 idx_messages_from_session + idx_messages_to_session 双索引 + UNION ALL（不走 OR 子句）
- **`alwaysOnTopCurrent` 必须显式删而非 void 标记**：留着会被 `noUnusedLocals` 触发 `TS6133`；setAlwaysOnTop 内的 `this.alwaysOnTopCurrent = value` 写操作也一并删（写但不读 = dead code）
- **migration 必须在 REMOVED_KEYS delete 之前**：if 顺序反了 → 旧字段 delete 后 raw 里没了 → migration 永远 noop → 老用户偏好丢失
- **wire prefix chip 仅 user role**：assistant role 也可能在 SDK 通道里出现 message kind event，但 wire prefix 仅 teammate 收 lead send_message 时由 watcher 注入到 user role 推送，assistant role 不应该被 chip 误标
- **MessagesPanel 200ms 节流而非按 from/to filter**：onAgentDeckMessageChanged payload shape `{kind, teamId, messageId, payload}[]` 没有 from/to 字段；解析每条 payload 增量更新比整体重拉 100 行 SQL 慢且复杂；先用整体重拉简单可靠，未来确实有性能瓶颈再优化
- **Phase 5 Step 5.5 dev smoke 推迟 Phase 6 H6**：与 J fix / K1 / K2 / K3 一起跑 smoke 更高效（plan §H4 进度同款 deferred 模式）
