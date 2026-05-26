# CHANGELOG_118

## 概要

archive-failure-ux-upthrow-20260515 plan 收口（REVIEW_39 R1 HIGH-3 R37 caller 仍 active 独立正交 root cause follow-up）—— caller archive 失败 UX 上抛通道，从 mcp baton-cleanup（archive_plan / hand_off_session）+ K3 SessionHandOffSpawn 三处触发 emit `caller-archive-failed` event → main bootstrap listener 桥 macOS 系统通知 + IPC 上抛 renderer。共 3 commit / 8 文件 / +432/-60 LOC / typecheck 双端 + vitest 531/595 全过(64 skipped 是 better-sqlite3 ABI 环境问题)。详 [REVIEW_42.md](../reviews/REVIEW_42.md)。

## 变更内容

### Commit 1 — Phase 2 实施（commit 8b9a96e）

R1 三态裁决后用户拍板修法 A 路径 1 macOS notifyUser + K3 一起修(P2 路径 2 renderer toast UI + 重试按钮留后续 plan)。8 文件 / +294/-29。

#### EventMap + IpcEvent

- `src/main/event-bus.ts`: EventMap 加 `'caller-archive-failed': [{ sessionId, toolName, reason, reasonKind: 'row-missing'|'archive-throw' }]` event + 详尽 jsdoc 描述触发点 3 处与 listener 桥接路径
- `src/shared/ipc-channels.ts`: `IpcEvent.CallerArchiveFailed = 'event:caller-archive-failed'`(renderer P2 enhancement 接入点预留)

#### baton-cleanup 两路 emit

- `src/main/agent-deck-mcp/tools/handlers/baton-cleanup.ts`:
  - 顶部 import eventBus + EventMap 类型
  - `RunBatonCleanupDeps` 加 `emitArchiveFailed?: (payload: EventMap['caller-archive-failed'][0]) => void` test seam(default 走 `eventBus.emit('caller-archive-failed', payload)`)
  - phase 2 archive 段两处 emit:
    - row-missing 路径(line 209-219): `callerRow` 探针 null → emit `reasonKind: 'row-missing'` + return 'failed'
    - archive-throw 路径(line 226-238): `archiveFn` 抛错 → emit `reasonKind: 'archive-throw'` + reason 含 stringified Error message + return 'failed'

#### K3 archiveSourceSessionWithEmit helper 抽离

- `src/main/ipc/sessions-hand-off-helper.ts`: 新增 `archiveSourceSessionWithEmit(sid, deps)` 纯函数 helper(deps 必填 archive + emitArchiveFailed,无 default 实现 — 避免拉 Electron import 链让 sessions.test.ts 不能 import)
- `src/main/ipc/sessions.ts`: K3 SessionHandOffSpawn 改用 helper + EventMap satisfies 编译期守门 schema 与 event-bus.ts 类型一致

#### main bootstrap listener

- `src/main/index.ts`:
  - 顶部 import `notifyUser` from `./notify/visual`
  - bootstrap `eventBus.on('caller-archive-failed', listener)` 调 `notifyUser({title: 'Agent Deck 归档失败', body, level: 'info'})` + `safeSend(IpcEvent.CallerArchiveFailed, payload)`
  - body 区分 reasonKind: `'archive-throw'` = 「原会话未归档,可重试归档(<shortSid>...,工具:<toolName>)」/ `'row-missing'` = 「原会话记录不可用,归档未完成(<shortSid>...,工具:<toolName>)」

#### 守门 test

- `src/main/agent-deck-mcp/__tests__/baton-cleanup.test.ts` case 6/7/8 加 emit 断言 payload schema(sessionId / toolName / reason 模糊匹配 / reasonKind 精确匹配)+ case 1/3 加 `emitFn not.toHaveBeenCalled` 守门「成功路径不误上抛」
- `src/main/ipc/__tests__/sessions.test.ts` 加 archiveSourceSessionWithEmit 3 case(archive ok / Error / non-Error stringify path)

### Commit 2 — R2 异构对抗 fix（commit ccd6d93）

R2 reviewer-claude HIGH-1 + reviewer-codex HIGH 双方独立提出 listener throw 撞穿 emit caller(node:events 实测 + grep notify/visual.ts 0 try/catch 铁证)+ MED-1 codex K3 row-missing 不可能结论错误 lead 现场 setArchived no-op 实证 + MED-1 claude SessionHandOffSpawn IPC 内部名暴露 lead IpcInvoke 字符串实证 + INFO 顺手修。5 文件 / +167/-24。

#### HIGH-1 fix(双方共识)— listener 顶部 try/catch + 改错误注释

- `src/main/index.ts:282-303`: caller-archive-failed listener 顶部包 try/catch + console.error 兜底,把错误注释「listener 自身故意不再加 try/catch — eventBus 单 listener 抛错只 console.error 不阻塞其它 listener,且 notifyUser / safeSend 都是 fire-and-forget 设计已自含错误兜底」改成准确描述「notifyUser 没自己 try/catch 内部调 settingsStore.getAll / Notification.isSupported / new Notification(...).show / playSoundOnce 任一抛错都会冒泡;safeSend (line 252) 也没 catch。Node EventEmitter 行为: listener throw 在 sync emit 中会冒泡到 emit 调用方」+ 完整说明撞穿后果(baton-cleanup / archiveSourceSessionWithEmit 内 emitFn 调用 reject → mcp tool 在核心操作已成功后返回失败 / K3 跳过 session-focus-request + newSid 返回 → 把「archive 失败 warn-only 不阻塞 caller」硬不变量彻底搞反)+ 修法

#### MED-1 (reviewer-codex) fix — K3 archiveSourceSessionWithEmit 加 getSession 探针 + reasonKind union

- `src/main/ipc/sessions-hand-off-helper.ts`:
  - `ArchiveSourceSessionDeps` 加 `getSession: (sid) => unknown | null` 必填 deps + 详尽 jsdoc(reviewer-codex MED-1 修法说明 + setArchived no-op 实证 + 与 mcp baton-cleanup 行为对齐)
  - `emitArchiveFailed` payload reasonKind 从单一 `'archive-throw'` 改成 union `'row-missing' | 'archive-throw'`(与 mcp baton-cleanup 对齐)
  - 函数体: archive 前重新探针 row,缺失则 emit `reasonKind: 'row-missing'` 短路(同款 try/catch fail-safe DB 异常)
- `src/main/ipc/sessions.ts`: K3 调用方传 `getSession: (id) => sessionRepo.get(id)` deps

#### MED-1 (reviewer-claude) fix — listener 加 toolName 用户友好映射表

- `src/main/index.ts:296-300`: `TOOL_DISPLAY_NAME: Record<string, string> = { archive_plan: 'plan 归档', hand_off_session: '会话接力', SessionHandOffSpawn: '会话接力' }` 映射表
- `src/main/index.ts:301-322`: listener body 用 `TOOL_DISPLAY_NAME[payload.toolName] ?? payload.toolName` 不直接拼 raw 字符串(避免 IPC channel 内部名 'SessionHandOffSpawn' 暴露给用户)

#### INFO (reviewer-claude) fix — case 9/10 加 emit not 守门

- `src/main/agent-deck-mcp/__tests__/baton-cleanup.test.ts` case 9/10: 加 `emitFn = vi.fn()` mock + `expect(emitFn).not.toHaveBeenCalled()` 守门 archive ok 路径不误上抛(零成本回归保护)

#### 守门 test 新增

- `src/main/ipc/__tests__/sessions.test.ts`: 加 R2 MED-1 row-missing case 4(getSession null → emit row-missing + 不调 archive)+ case 5(getSession 抛错 DB 异常 fail-safe → 走 row-missing 路径 emit)

### Commit 3 — R3 fix(reviewer-codex MED-1)（commit 67365e7）

R3 reviewer-codex MED-1 单方 + lead 现场验证 try 块结构: notifyUser/safeSend 在同 try 块串行执行,notifyUser 同步抛错时 safeSend 不会执行 → 双通道桥接退化为单通道(macOS 通知故障时 renderer IPC 也丢)。1 文件 / +18/-7。

#### MED-1 fix — listener 拆双通道独立 try/catch

- `src/main/index.ts:309-319`: 通道 1(notifyUser macOS 通知)与通道 2(safeSend IPC 上抛)各自独立 try/catch + console.error 兜底,任一通道异常不影响另一通道。外层保留总 try/catch 兜底防撞穿 emit caller(R2 fix HIGH-1 守门保留)

## 不变量保留

- archive 失败 warn-only 仍 by design(let ok return 不阻塞 caller),仅加 UX 上抛通道(本 plan §不变量明确禁止改成 abort)
- mcp handler 与通知层职责分离(baton-cleanup 通过 eventBus 桥不直接 import notify/visual.ts)
- helper 抽离避免 sessions.test.ts 拉 Electron import 链(sessions-hand-off-helper.ts 注释明示 ground truth)

## ❓ 不修留 follow-up plan

### MED 级 — K3 helper probe-then-archive TOCTOU race window(R3 双方共识)

K3 `archiveSourceSessionWithEmit` 的 `getSession` sync 探针 OK 后到 `await deps.archive(sid)` 之间至少一个 microtick,row 可被外部删除 → setArchived UPDATE silent resolve → helper 走 archive ok 不 emit。**不是 R2 fix 引入**(同款 race window 在 mcp baton-cleanup R1 已存在)+ scope 超本 plan(修法涉及 archive contract 行为变更影响所有 archive 调用方,需独立 plan `archive-toctou-fix-<date>` 收口)+ production 触发概率低(lifecycle scheduler 周期 5min)。详 REVIEW_42 §已知 follow-up

### LOW 级 — getSession 抛错归类 row-missing 隐藏 UI 重试(R2 reviewer-codex LOW)

DB locked / read failure 不等价于 row 不存在,重试可能有效。修法需扩 reasonKind union(`'probe-throw'`)推到全链路(EventMap + 三处 emit + 5 处 case),留 polish plan

### INFO 级 — 约定升级与 P2 enhancement

- TOOL_DISPLAY_NAME `Record<string, string>` 应 narrow 到 union(EventMap toolName 升级 union)强制完整覆盖,避免加新 emit 触发点忘加映射条目时 fallback 到 raw 字符串 regression UX
- 架构层: `eventBus.on` 包成 `eventBus.onSafe(...)` 自动兜底 helper,所有 listener 走 onSafe(scope = main/index.ts 7 个其他 listener 全部统一升级)
- TOOL_DISPLAY_NAME 提模块顶部 + `as const` literal narrow(微 polish 工程美学)
- 未知 toolName fallback 加 dev 期 console.warn(微 polish 加新 emit 触发点忘加映射时开发期立即发现)
- renderer P2 enhancement(toast UI + 重试按钮)— P1 已落地 IPC channel `IpcEvent.CallerArchiveFailed` + `window.api.archiveSession` 接入点预留,P2 plan 加全局 toast 容器 listen IPC + 显示「重试归档」按钮
- archive-throw 段代码重复 ~10 行(sessions-hand-off-helper.ts vs baton-cleanup.ts)— explicit > clever 当前不修

## 验证

- typecheck: claude + codex 双 tsconfig 全过(R3 final commit 67365e7)
- vitest: 531 passed / 64 skipped(better-sqlite3 ABI 环境守门 by design;比 base 多 2 个 R2 MED-1 row-missing case)
- 异构对抗强度: ✅ **完整**(`heterogeneous_dual_completed: true`,三轮全部双方独立 reply,R2/R3 复用同对 reviewer 跨轮 mental model 持久化)
