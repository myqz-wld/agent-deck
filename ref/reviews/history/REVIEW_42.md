---
review_id: REVIEW_42
title: archive-failure-ux-upthrow caller archive 失败 UX 上抛三轮异构对抗 review × fix(R1 修法决策 + R2 实施 review + R3 fix 复核)
created_at: 2026-05-15
plan_id: archive-failure-ux-upthrow-20260515
worktree_path: /Users/apple/Repository/personal/agent-deck/.claude/worktrees/archive-failure-ux-upthrow-20260515
base_commit: b7ba2b2
final_commit: 67365e7
parent_review_id: REVIEW_39
heterogeneous_dual_completed: true
---

# REVIEW_42 — archive-failure-ux-upthrow 三轮异构对抗 review × fix

## 触发场景

REVIEW_39 / hand-off-mcp-teammate-bug-20260515 plan 收口时挖出的**独立正交** HIGH root cause:R37 caller `024289d4` 实测 lifecycle=active(应被 R37 archive_plan 自动归档但未生效)。双 reviewer R1+R1.5 反驳轮共识 3 类可能场景:

- **场景 A**: archive 失败 warn-only 被吞 — `baton-cleanup.ts` archive='failed' 字段透传到 mcp tool ok return string 字段 **无消费方**(grep 验证 renderer / IPC handler / event-bus 全 0 处),用户感知不到
- **场景 B**: 旧版本 archive_plan 不归档 caller(R37 archive 在 CHANGELOG_99/CHANGELOG_109 baton-cleanup 改造之前)— pre-existing 状态不可改
- **场景 C**: unarchiveOnUserSend 拉回 live(`manager.ts:337-341` 用户从 UI 续聊已归档 caller 自动 unarchive)— by design 用户主动续聊

REVIEW_39 / CHANGELOG_112 收口时双 reviewer 共识保留为**独立正交** follow-up,本 plan + REVIEW 即收口该 follow-up(仅修场景 A;B/C 不修)。

## 方法

### Scope = plan 3 commit / 8 文件 / +432/-60 LOC

**主线 3 commit**:
- `8b9a96e` Phase 2 实施(R1 修法 A 路径 1 macOS notifyUser + K3 一起修): event-bus.ts EventMap + ipc-channels.ts IpcEvent.CallerArchiveFailed + baton-cleanup.ts 两路 emit + sessions-hand-off-helper.ts archiveSourceSessionWithEmit 抽离 + sessions.ts K3 调 helper + main/index.ts bootstrap listener + 守门 test (8 文件 / +294/-29)
- `ccd6d93` R2 fix(reviewer-claude HIGH-1 + reviewer-codex HIGH 双方共识 + reviewer-codex MED-1 + reviewer-claude MED-1 + INFO 顺手): listener 顶部 try/catch + 改错误注释 / K3 getSession 探针 + reasonKind union / TOOL_DISPLAY_NAME 映射表 / case 9/10 emit not 守门 (5 文件 / +167/-24)
- `67365e7` R3 fix(reviewer-codex MED-1): listener 拆双通道独立 try/catch (1 文件 / +18/-7)

### 异构对抗 reviewer

**三轮全部 heterogeneous_dual_completed: true**。R1 由前会话做(plan Step 1.3),R2+R3 由本会话做(plan Phase 3 Step 3.1 复用同对 reviewer 跨轮持久化 mental model)。

| Reviewer | 模型 | R1 | R2 | R3 |
|---|---|---|---|---|
| **reviewer-claude** | Opus 4.7 | sid `3fb611ac` (已 shutdown,messages 子表保留) | sid `d41200a2` | 同 R2 复用 |
| **reviewer-codex** | gpt-5.5 xhigh | sid `48679ea5` (已 shutdown,messages 子表保留) | sid `83943e88` | 同 R2 复用 |

R2/R3 反复轮均通过应用 `agent-deck:deep-code-review` SKILL teammate 模式编排(跨轮 mental model 持久化 + reply 自动注入 lead conversation flow,详 user CLAUDE.md §决策对抗 + 应用 CLAUDE.md §Universal Team Backend)。

## R1 三态裁决(plan Step 1.3 摘要,详细 Step 2.1 用户决策)

R1 是「修法决策 review」(scope = 修复策略 A/B/C/D),非「代码 review」。

### 共识 HIGH 4 条(异构强证据,双方角度互异结论一致)

| ID | 严重度 | 内容 |
|---|---|---|
| **H1** | HIGH | 修法 A(emit IPC event + macOS 通知)双方共识推荐 |
| **H2** | HIGH | 修法 B(ok return userActionable 字段)双方反驳 |
| **H3** | HIGH | 修法 C(archive_failed_at 列 + 角标)双方反驳 |
| **H4** | HIGH | 修法 D(退化 lifecycle=closed)双方反驳 |

### 单方独有 + 现场验证 5 条 MED(全 ✅)

| ID | 单方 | 验证 |
|---|---|---|
| **M1** | reviewer-codex | renderer 无全局 toast 基建(grep 验证仅 NotifySection/controls/SessionDetail 局部 3 处) |
| **M2** | reviewer-codex | notifyUser API + enableSystemNotification setting 现成(visual.ts:14, 29) |
| **M3** | reviewer-claude | K3 SessionHandOffSpawn 同款静默(ipc/sessions.ts:144 走独立 sessionManager.archive 不经 baton-cleanup helper)→ K3 一起修 |
| **M4** | reviewer-codex | window.api.archiveSession 现成(preload/api/sessions.ts:37,P2 enhancement 重试按钮接入点) |
| **M5** | 双方共识 | reason 字段区分 row-missing vs archive-throw |

### LOW P2 follow-up 2 条

| ID | 严重度 | 内容 |
|---|---|---|
| **LOW-1** | LOW | case 5 phase 1 shutdown 通知(scope 外)|
| **LOW-2** | LOW | row 存在时写 ActivityFeed SimpleRow 内联提示(P2 enhancement)|

### Step 2.1 用户决策

修法 A 路径 1(MVP macOS notifyUser + IPC channel)+ K3 一起修 + 路径 2(renderer toast UI + 重试按钮)留 P2 enhancement 后续 plan。

## R2 三态裁决(reviewer-codex 4 finding + reviewer-claude 6 finding)

scope: Phase 2 实施代码 commit `8b9a96e` 8 文件 diff。

### 真问题(必修)

| ID | 严重度 | 内容 | 出处 + 验证 | 落地 commit |
|---|---|---|---|---|
| **HIGH-1** | HIGH | listener 同步异常会反向打崩 warn-only 语义 — `notifyUser`/`safeSend` 内若同步抛错会让 `eventBus.emit('caller-archive-failed', ...)` 反向 throw,破坏 baton-cleanup/archiveSourceSessionWithEmit「archive 失败 warn-only」硬不变量 | **双方独立提出**(异构强证据): reviewer-codex 实测 `node:events` listener throw + reviewer-claude 写 `/tmp/test-listener-throw.mjs` + grep notify/visual.ts 全文 0 处 try/catch | ccd6d93 |
| **MED-1 (codex)** | MED | K3 hand-off `row-missing 不可能` 结论不成立 — `createSession` 长 async 窗口内 source row 可被删,`sessionManager.archive` UPDATE 是 silent no-op resolve → emit 不会触发 | reviewer-codex 单方 + lead 现场验证 setArchived (archive.ts:19) 裸 UPDATE 不查 .changes + manager.archive (manager.ts:296-306) 对缺失 row silent resolve | ccd6d93 |
| **MED-1 (claude)** | MED | `toolName='SessionHandOffSpawn'` 是 IPC channel 内部名(`IpcInvoke.SessionHandOffSpawn = 'session:hand-off-spawn'`),用户在 UI 看到泄漏的内部名 | reviewer-claude 单方 + lead 现场验证 IpcInvoke 字符串 | ccd6d93 |

### INFO 顺手修

| ID | 严重度 | 内容 | 落地 commit |
|---|---|---|---|
| **INFO (claude)** | INFO | baton-cleanup.test.ts case 9/10 没显式 `emit not.toHaveBeenCalled` 守门 happy path 不误上抛(零成本回归保护) | ccd6d93 |

### ❓ 不修

| ID | 严重度 | 内容 | 出处 + 判定 |
|---|---|---|---|
| **LOW-1 (codex)** | LOW | `getSession` 抛错归类 row-missing,UI 文案误说「记录不可用」隐藏「重试归档」按钮 | reviewer-codex 单方 + 现状可接受。改动需扩 reasonKind union 推到全链路(EventMap + 三处 emit + 5 处 case),留 polish plan |
| **LOW-2 (claude)** | LOW | `archive-throw` 段代码重复 ~10 行(sessions-hand-off-helper.ts:68-85 vs baton-cleanup.ts:222-242)— 可抽 micro-helper | reviewer-claude 单方 + explicit > clever 当前可接受。toolName 字面量类型 narrow 与 console.warn 前缀不同要参数化 |
| **INFO ×3 (claude)** | INFO | enableSystemNotification=false + P2 未实施 = 完全无用户感知(by design 留 P2)/ helper interface 类型派生方式不一致(EventMap 派生 vs hardcoded inline + satisfies)| 留约定升级 / P2 enhancement |
| **INFO ×3 (codex)** | INFO | schema 一致 / listener 单次注册 / codex 沙盒未跑 vitest | 全 acknowledge |

## R3 三态裁决(reviewer-codex 2 MED + reviewer-claude 1 LOW + 4 INFO)

scope: R2 fix commit `ccd6d93` 5 文件 diff。

### 真问题(必修)

| ID | 严重度 | 内容 | 出处 + 验证 | 落地 commit |
|---|---|---|---|---|
| **MED-1 (codex)** | MED | `notifyUser`/`safeSend` 在同 try 块串行执行,`notifyUser` 同步抛错时 `safeSend` 不会执行 → 双通道桥接退化为单通道(macOS 通知故障时 renderer IPC 也丢) | reviewer-codex 单方 + 现场验证: nl 读 index.ts:301-319 + notify/visual.ts:14-35 确认 notifyUser 无内部 try/catch + safeSend 在同一 try 块排在其后 | 67365e7 |

### ❓ 不修留独立 follow-up plan(双方共识但 scope 超本 plan)

| ID | 严重度 | 内容 | 出处 + 判定 |
|---|---|---|---|
| **MED-2 (codex) / LOW-1 (claude)** | MED / LOW | K3 helper getSession 探针 OK 后到 `await deps.archive(sid)` 之间至少一个 microtick,lifecycle scheduler / 用户手动 close / DB reaper 任一可在窗口内删 row → setArchived UPDATE silent resolve → helper 走 archive ok 不 emit | **双方共识**(R3 异构强证据)。reviewer-claude 评估「不是 R2 fix 引入(mcp baton-cleanup R1 已存在同款 race window),修法影响所有 archive 调用方 scope 超本 plan」+ reviewer-codex 标 MED 但建议同款修法。详 §已知 follow-up |

### INFO 不修

| ID | 严重度 | 内容 | 判定 |
|---|---|---|---|
| **INFO (claude)** | INFO | `TOOL_DISPLAY_NAME: Record<string, string>` 应 narrow 到 union 强制完整覆盖 | 当前 `?? payload.toolName` fallback 已是软兜底,加 union 是约定升级层面 |
| **INFO (claude)** | INFO | 其他 7 个 eventBus listener 同样应该兜底 try/catch 防撞穿 emit caller(架构层面)| scope 超本 plan,推 universal try/catch 模板属架构升级,可后续 plan 把 `eventBus.on` 包成 `eventBus.onSafe` 自动兜底 helper |
| **INFO (claude)** | INFO | TOOL_DISPLAY_NAME 内联 const 应提模块顶部 + `as const` literal narrow | 微 polish 不必修 |
| **INFO (claude)** | INFO | 未知 toolName fallback 加 dev 期 console.warn 提示开发期发现 | 微 polish 不必修 |
| **INFO ×3 (codex)** | INFO | TOOL_DISPLAY_NAME 三个 toolName 全覆盖 / row-missing 测试未覆盖 probe-ok-then-archive-no-op TOCTOU(MED-2 范畴)/ git diff check 通过 | 全 acknowledge |

## 修复条目

### Phase 2 实施(详 commit 8b9a96e)

#### EventMap + IpcEvent + bootstrap listener

- `src/main/event-bus.ts`: EventMap 加 `'caller-archive-failed': [{ sessionId, toolName, reason, reasonKind: 'row-missing'|'archive-throw' }]` event
- `src/shared/ipc-channels.ts`: `IpcEvent.CallerArchiveFailed = 'event:caller-archive-failed'` (renderer P2 enhancement 接入点预留)
- `src/main/index.ts`: bootstrap eventBus.on('caller-archive-failed') listener 调 `notifyUser({title, body, level:'info'})` + `safeSend(IpcEvent.CallerArchiveFailed, payload)`,文案区分 reasonKind('archive-throw' = 「原会话未归档,可重试归档(<shortSid>...)」/ 'row-missing' = 「原会话记录不可用,归档未完成」)

#### baton-cleanup 两路 emit

- `src/main/agent-deck-mcp/tools/handlers/baton-cleanup.ts`:
  - 顶部 import eventBus + EventMap 类型
  - RunBatonCleanupDeps 加 `emitArchiveFailed?: (payload: EventMap['caller-archive-failed'][0]) => void` seam(default 走 `eventBus.emit('caller-archive-failed', payload)`)
  - phase 2 archive 段两处 emit:
    - row-missing 路径(line 209-219): `callerRow` 探针 null → emit `reasonKind: 'row-missing'` + return 'failed'
    - archive-throw 路径(line 226-238): `archiveFn` 抛错 → emit `reasonKind: 'archive-throw'` + reason 含 stringified Error message + return 'failed'

#### K3 archiveSourceSessionWithEmit helper 抽离

- `src/main/ipc/sessions-hand-off-helper.ts`: 新增 `archiveSourceSessionWithEmit(sid, deps)` 纯函数 helper(deps 必填 archive + emitArchiveFailed,无 default 实现以避免拉 Electron import 链)
- `src/main/ipc/sessions.ts`: K3 SessionHandOffSpawn 改用 helper + EventMap satisfies 编译期守门 schema 一致性

#### 守门 test

- `src/main/agent-deck-mcp/__tests__/baton-cleanup.test.ts`: case 6/7/8 加 emit 断言 payload schema(sessionId / toolName / reason 模糊匹配 / reasonKind 精确匹配)+ case 1/3 加 `not.toHaveBeenCalled` 守门「成功路径不误上抛」
- `src/main/ipc/__tests__/sessions.test.ts`: 加 archiveSourceSessionWithEmit 3 case(archive ok / Error / non-Error stringify path)

### R2 fix(详 commit ccd6d93)

#### HIGH-1 fix — listener 顶部 try/catch + 改错误注释

- `src/main/index.ts:282-303`: caller-archive-failed listener 顶部包 try/catch + console.error 兜底,把错误注释「listener 自身故意不再加 try/catch — eventBus 单 listener 抛错只 console.error 不阻塞其它 listener,且 notifyUser / safeSend 都是 fire-and-forget 设计已自含错误兜底」改成准确描述「notifyUser 没自己 try/catch 内部调 settingsStore.getAll / Notification.isSupported / new Notification(...).show / playSoundOnce 任一抛错都会冒泡;safeSend (line 252) 也没 catch。Node EventEmitter 行为: listener throw 在 sync emit 中会冒泡到 emit 调用方」+ 完整说明撞穿后果 + 修法

#### MED-1 (reviewer-codex) fix — K3 archiveSourceSessionWithEmit 加 getSession 探针 + reasonKind union

- `src/main/ipc/sessions-hand-off-helper.ts`:
  - ArchiveSourceSessionDeps 加 `getSession: (sid) => unknown | null` 必填 deps + 详尽 jsdoc(reviewer-codex MED-1 修法说明 + setArchived no-op 实证)
  - emitArchiveFailed payload reasonKind 从单一 `'archive-throw'` 改成 union `'row-missing' | 'archive-throw'`(与 mcp baton-cleanup 对齐)
  - 函数体: archive 前重新探针 row,缺失则 emit `reasonKind: 'row-missing'` 短路(同款 try/catch fail-safe DB 异常)
- `src/main/ipc/sessions.ts`: K3 调用方传 `getSession: (id) => sessionRepo.get(id)` deps

#### MED-1 (reviewer-claude) fix — listener 加 toolName 用户友好映射表

- `src/main/index.ts:296-300`: `TOOL_DISPLAY_NAME: Record<string, string> = { archive_plan: 'plan 归档', hand_off_session: '会话接力', SessionHandOffSpawn: '会话接力' }` 映射表
- `src/main/index.ts:301-322`: listener body 用 `TOOL_DISPLAY_NAME[payload.toolName] ?? payload.toolName` 不直接拼 raw

#### INFO (reviewer-claude) fix — case 9/10 加 emit not 守门

- `src/main/agent-deck-mcp/__tests__/baton-cleanup.test.ts` case 9/10: 加 `emitFn = vi.fn()` mock + `expect(emitFn).not.toHaveBeenCalled()` 守门 archive ok 路径不误上抛(零成本回归保护)

#### 守门 test 新增

- `src/main/ipc/__tests__/sessions.test.ts`: 加 R2 MED-1 row-missing case 4(getSession null)+ case 5(getSession 抛错 DB 异常 fail-safe → 走 row-missing 路径)

### R3 fix(详 commit 67365e7)

#### MED-1 (reviewer-codex) fix — listener 拆双通道独立 try/catch

- `src/main/index.ts:309-319`: 通道 1(notifyUser macOS 通知)与通道 2(safeSend IPC 上抛)各自独立 try/catch + console.error 兜底,任一通道异常不影响另一通道。外层保留总 try/catch 兜底防撞穿 emit caller(R2 fix HIGH-1 守门保留)

## 验收

- typecheck: claude + codex 双 tsconfig 全过(R3 final)
- vitest: **531 passed / 64 skipped**(better-sqlite3 ABI 环境守门 by design;比 base 多 2 个 R2 MED-1 row-missing case)
- 异构对抗强度: ✅ **完整**(`heterogeneous_dual_completed: true`,三轮全部双方独立 reply,R2/R3 复用同对 reviewer 跨轮 mental model 持久化)
- R1 共识 HIGH 4 + R2 真问题 4 + R3 真问题 1 = **9 条 ✅ 真问题全修**
- R3 双方共识 race window MED-2 留 §已知 follow-up

## 已知 follow-up(本 plan 不做)

### MED 级 — K3 helper probe-then-archive TOCTOU race window(R3 双方共识)

**问题**: K3 `archiveSourceSessionWithEmit` 的 `getSession` sync 探针 OK 后到 `await deps.archive(sid)` 之间至少一个 microtick(await Promise.resolve() 等),lifecycle scheduler / 用户手动 close / DB reaper 任一可在窗口内删 row → `setArchived` UPDATE 不查 `.changes` 对缺失 row silent resolve → `sessionManager.archive` (`manager.ts:296-306`) 拿 updated == null 只是不 emit `session-upserted` 不抛错 → helper 走 archive ok 不 emit caller-archive-failed → 用户完全无感知 row 已被删。

**为什么不阻塞合并**:
1. **同款 race window 在 mcp baton-cleanup 已存在**(R1 引入,与 K3 helper 同模式 sync 探针 + async archive),R2 fix 把 K3 helper 行为对齐 baton-cleanup → **不是 R2 fix 引入的新问题**
2. R1/R2 已裁决类似问题(baton-cleanup MED-2)按「探针 ground truth」修,**没人改 archive 本身**
3. production 触发概率低(lifecycle scheduler 周期 5min / 用户手动 close 同时归档罕见)

**修法**(三选一,任一都涉及 archive contract 行为变更影响所有 archive 调用方):
- **(a)** `setArchived` 改成检查 `.changes === 1`,affected rows 0 → throw → caller 走 archive-throw 路径
- **(b)** `sessionManager.archive` 在 setArchived 后 `sessionRepo.get` 看 updated null → throw
- **(c)** 接受 race window 显式文档「极小概率 silent miss」

**牵连影响**: 任一 (a)/(b) 修法都需要全面验证所有 archive 调用方(IPC SessionArchive handler / sessionManager 内部 / lifecycle scheduler / archiveTeamsIfOrphaned)+ 同款修法应用到 mcp baton-cleanup helper 保持对称 + 相关 test 调整。建议独立 plan `archive-toctou-fix-<date>` 收口。

### LOW 级 — getSession 抛错归类 row-missing 隐藏 UI 重试(R2 reviewer-codex)

**问题**: SQLite locked / DB read failure 不等价于 row 不存在,重试可能有效。但当前 listener 文案走「原会话记录不可用」,P2 renderer 也会按 `row-missing` 不展示重试按钮。

**修法**: 拆出 `probe-throw` reasonKind,或至少把 probe 异常映射到可重试类。需扩 reasonKind union 推到全链路(EventMap + 三处 emit + 5 处 case),留 polish plan。

### INFO 级 — 约定升级与 P2 enhancement

- **TOOL_DISPLAY_NAME Record union narrow**: EventMap toolName 升级 union(`'archive_plan' | 'hand_off_session' | 'SessionHandOffSpawn'`)+ `Record<KnownToolNames, string>` 强制完整覆盖,加新 emit 触发点忘加映射条目编译期 fail
- **架构层 listener defense-in-depth**: 把 `eventBus.on` 包成自动兜底 helper(`eventBus.onSafe(...)`),所有 listener 走 onSafe 不允许走 .on 直传。scope = main/index.ts 7 个其他 listener 全部统一升级
- **TOOL_DISPLAY_NAME 提模块顶部 + `as const`**: 微 polish 工程美学
- **未知 toolName dev 期 console.warn**: 微 polish 加新 emit 触发点忘加映射条目时开发期立即发现 regression UX
- **renderer P2 enhancement(toast UI + 重试按钮)**: P1 已落地 IPC channel(`IpcEvent.CallerArchiveFailed`)与 `window.api.archiveSession` 接入点预留,P2 plan 加全局 toast 容器 listen IPC + 显示「重试归档」按钮(reasonKind='archive-throw' 显示 / 'row-missing' 仅告知)
- **archive-throw 段代码重复**: sessions-hand-off-helper.ts:68-85 vs baton-cleanup.ts:222-242 ~10 行可抽 micro-helper(toolName 字面量类型 narrow 与 console.warn 前缀参数化)。explicit > clever 当前不修

## 关联 changelog

[CHANGELOG_118.md](../../changelogs/history/CHANGELOG_118.md)
