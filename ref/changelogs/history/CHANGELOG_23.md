# CHANGELOG_23: REVIEW_4 修复落地（4 HIGH + 17 MED + 2 LOW，跨 19 文件）

## 概要

REVIEW_4（origin/main..HEAD 双对抗）三态裁决后修复落地，覆盖批 1 后端核心 / 批 2 settings / 批 3 activity-feed 全部 4 条 HIGH + 17 条 MED + 选改 2 条 LOW（L4 EMPTY_EVENTS freeze、L8 manager.test 公共 API + H1 回归补测）。本批不引新功能，专注修问题与加固，按 CLAUDE.md 写到 changelog/ 而非 reviews/ 是因为这些修复**改了运行时行为**（不只是审视报告），下游消费方可见。

## 变更内容

### 主进程 / 数据完整性

#### `src/main/store/payload-truncate.ts` + `payload-truncate.test.ts`（H3）

- 字节预算改为 `Buffer.byteLength(s, 'utf8')`，不再混用 `string.length`（UTF-16 code unit）让中文 / emoji 字节悄悄突破 3 倍上限
- 新增 `truncateStringByBytes`：按 utf-8 leading-byte 边界回退，避免切到 multi-byte sequence 中间产生孤儿字节
- KNOWN_LARGE 数组分支对 element 递归 `shrinkLargeFieldsDeep`，处理 Claude tool_result 真实嵌套 `{type:'tool_result', content:[{type:'text', text:'...'}]}` 结构
- `safeTruncateBlob` 也走 utf-8 安全切；`safeStringifyPayload` marker preview 走同款安全切
- 单测补 4 项：嵌套 toolResult 递归截 / UTF-8 字节预算 / emoji surrogate 不切孤儿（断言无 `�` + 无 lone surrogate） / blob UTF-8 字节阈值
- 单测改 `'x'.repeat(MAX + 100)`（旧版 `+ 5_000` 失败 dump 13KB 触发 AUP，P9 教训）+ `.toMatch(/regex/)` 替代 `.toContain` 让失败信息少打原文

#### `src/main/ipc.ts`（H2 + M1-M3 + M4 + L9）

- **H2 SettingsSet 事务回滚补完整**：catch 路径除了 `settingsStore.patch(rollback)` 也跑一遍 `apply*` 链让 scheduler / loginItem / window.alwaysOnTop / adapter 实例 / cache 都退到 before 状态（每个 apply 单独 try/catch 防一个回滚函数抛错把后续都吞掉）
- **新增校验 helper**：`IpcInputError` + `parsePositiveInt` / `parseStringId` / `parseHookScope` / `parsePermissionMode` / `parseStringIdArray` 在 IPC 边界一次性收口
  - SessionListEvents `limit`：1-5000 整数
  - SessionListSummaries / Latest 等 ID 数组：≤500 项 + 单 ID 长度 ≤256
  - HookInstall/Uninstall/Status `scope`：`'user' | 'project'` 枚举
  - AdapterCreateSession `permissionMode`：`'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'` 白名单
  - AdapterCreateSession `cwd`：null/undefined → homedir 兜底；非空字符串 trim；长度 ≤4096
  - AdapterCreateSession `prompt` + AdapterSendMessage `text`：`Buffer.byteLength(text, 'utf8')` ≤ 100KB（与 sdk-bridge 对齐，前置在 IPC 层）
  - ClaudeMdSave `content`：必须 string + ≤ 2MB
- **L9 image stat→readFile TOCTOU**：用 `fsp.open(real, 'r')` 拿 `FileHandle`，stat 与 readFile 都走同 fd，try/finally 确保 fd close
- SessionDelete handler 改 `await sessionManager.delete(...)`（配套 H1 改 manager.delete 为 async）

#### `src/main/session/manager.ts`（H1）

- **删除会话竞态**：`delete()` 改 async，await `sessionCloseFn` 完成才 sessionRepo.delete + 广播
- 加「最近删除黑名单」`recentlyDeleted: Map<sessionId, deletedAt>` + 60s TTL：`ingest()` 入口检查命中即丢弃，防 SDK 流终止 / 异常 stream 的尾包在 sessionRepo.delete 后到达 `ensureRecord` 复活成幽灵 record

#### `src/main/adapters/codex-cli/sdk-bridge.ts`（H1 + M4 + M5）

- `InternalSession` 加 `intentionallyClosed: boolean` 标记
- `closeSession()`：abort **之前**置 `intentionallyClosed = true`
- `runTurnLoop` catch 块入口：看到 `intentionallyClosed` 静默退出（不 emit `finished/message`），消除「abort 触发 catch → emit finished:interrupted → manager 复活幽灵」根因
- 30s timeout fallback 路径同样先置 `intentionallyClosed = true` 再 abort，消除「fallback emit finished:error + catch emit finished:interrupted」双 finished
- `createSession` 入口加 `MAX_MESSAGE_BYTES` 校验首条 prompt（旧版只 `sendMessage` 校验，pendingMessages 直接进队列让其他入口可绕过 100KB 上限）

#### `src/main/notify/event-router.ts`（M6 + M7）

- 整段包 try/catch：`notifyUser` 内 Notification / dock.bounce / playSoundOnce 任一抛错只 console.error 不冒泡，避免冒到 adapter for-await emit 循环切断后续事件流
- `finished` 事件区分 `payload.ok / subtype`：subtype `interrupted` → 「Agent 已中断」，其它 ok=false → 「Agent 出错」，ok=true → 「Agent 完成」（避免与 H1 修复后的合法尾包凑成莫名「完成」通知）

#### `src/main/adapters/claude-code/sdk-injection.ts` + `src/preload/index.ts`（M11 IPC API 改动）

- `saveUserAgentDeckClaudeMd(content)` 返回 `{content, isCustom: true}`：写 tmp + rename 后 `readFileSync` 读回真实写盘内容供 renderer 同步本地 loaded 状态
- preload `saveClaudeMd` 类型同步：`Promise<{content, isCustom: true}>` 替代旧 `Promise<{ok: boolean}>`
- 防 main 端将来做规范化（去 BOM / CRLF→LF / 补尾换行）后下次 dirty 永真，「保存」按钮永亮但 IPC 没东西可写

### 测试

#### `src/main/session/__tests__/manager.test.ts`（L8 + H1 回归）

- 加 `setSessionCloseFn` mock，让 delete 测可控关 SDK
- 新增 3 组「公共 API 主路径」测试：`archive` / `unarchive`（验证「lifecycle 与 archived 正交」约定）/ `reactivate`
- 新增 3 组「H1 删除后尾包不复活幽灵」测试：
  - `delete()` await close + 删 DB 行 + 广播 `session-removed`
  - 删除窗口内 SDK `finished:interrupted` 尾包被 `recentlyDeleted` 黑名单丢弃（断言 events 表无新增 + upserted/agent-event 广播总数不变）
  - 删除窗口内 hook 通道 `message` 尾包同样被丢

### Renderer / Settings 拆分增强

#### `src/renderer/components/SettingsDialog.tsx`（M8 + M9 + M11 + L2）

- M8: `getSettings` 失败时降级用 `DEFAULT_SETTINGS` 兜底渲染表单（`setSettings((prev) => prev ?? {...DEFAULT_SETTINGS})`），不再死锁在「读取设置中…」；写设置仍可用
- M9: 加 `openSeqRef` + `updateSeqRef` 两个序号 ref，弹窗快速切换 / 连点多个 toggle 时旧响应被新 update 抢答时丢弃，避免回写旧值 toggle 闪回
- M11: `onClaudeMdDirtyChange` 用 `useCallback` 稳定 identity，防 child useEffect cleanup→run 在 parent rerender 时误触发伪 false
- LOW: `guardedClose` 加 `closeInFlightRef` 标记防多次点 ✕ 弹多个 confirm；`✕` 按钮加 `aria-label="关闭设置"`

#### `src/renderer/components/settings/ClaudeMdEditor.tsx`（M11）

- `save()` 用 `window.api.saveClaudeMd` 返回的 `{content, isCustom}` 更新 loaded + draft（而非用本地 draft 直接 set）

#### `src/renderer/components/settings/controls.tsx`（M12 + M13）

- `NumberInput`：`editing` 用 ref 持有出 effect 依赖，effect 仅 watch `[value]` 同步草稿。修原 `[value, editing]` 在 commit→`setEditing(false)` 触发时立刻把 setDraft(clamped) 倒回 旧 value 的 flicker
- 加 `integer?: boolean` prop（默认 true）：commit 时 `Math.trunc` + `step={integer ? 1 : 'any'}`，避免 1.5 流进 hookServerPort / summaryEventCount 等整数语义设置

### Renderer / ActivityFeed 性能与稳定

#### `src/renderer/stores/session-store.ts`（H4 配套）

- `RECENT_LIMIT` 从 30 提到 200（与 SessionListEvents 默认 limit 对齐 + 公开 export 给 activity-feed 消费）
- `setRecentEvents` 也走 `events.slice(0, RECENT_LIMIT)`：防 listEvents 拉 100 条后 `pushEvent` slice(0, 30) 让 70 条历史秒蒸发
- 旧版底部 `export {EMPTY_REQUESTS, ...}` 已并入文件上方一次性 export

#### `src/renderer/components/activity-feed/index.tsx`（H4 + M14 + M18 + L1）

- `listEvents(sessionId, RECENT_LIMIT)` 替代硬编码 100，常量同源避免再走样
- `listEvents` 加 `.catch`：失败时 `setLoaded(true) + setLoadError`，feed 进可恢复错误态而非死锁加载中
- `listAdapterPending` 加 `.catch` 静默 console（不阻塞主链路）
- `pendingPermIds / pendingAskIds / pendingExitIds` 用 `useMemo([pendingPermissions])` 锁定；`cancelledPermIds` 等三组合并 `useMemo([recent])` 一次扫
- `ActivityRow` 包 `React.memo`：props 引用稳定时跳过 re-render
- `<ol>` 加 `role="log" + aria-live="polite" + aria-relevant="additions"`，屏阅器跟进新事件

#### `src/renderer/components/activity-feed/format.ts`（M19）

- `eventKey` `message`/`thinking` 走 `${sessionId}:${kind}:${ts}:${text.slice(0, 32)}` 形态，避免同毫秒同 kind 撞 key 让 React 复用错 row 的 useState（MD/TXT, ▾/▸）

#### `src/renderer/components/activity-feed/shared.ts`（L4）

- `EMPTY_EVENTS` 用 `Object.freeze` 防消费方误 push 污染所有会话兜底引用

#### `src/renderer/components/activity-feed/rows/tool-row.tsx`（M15 + M17）

- `ToolStartRow`：DiffViewer 改 click-to-expand，加「展开 diff / 收起 diff」按钮，避免多条 Edit 同窗口几十个 Monaco 实例同时 mount
- `ToolEndRow`：`formatToolResult` / `parseImageReadResult` 用 `useMemo([result])` 锁定，大结果场景下父级 rerender 不再重做 JSON.stringify / parse

#### `src/renderer/components/activity-feed/rows/{message,thinking}-row.tsx`（M16）

- 单条 message > 800 字符 / thinking > 600 字符默认折叠（`max-h-72 / max-h-56 + overflow-auto` + 「展开 (N字)」按钮）。防 SDK 推超长 system 提示 / 用户粘贴大段日志撑成一面墙

## 验证

```bash
pnpm typecheck   # ok
pnpm test        # 37 passed (search-predicate 13 + manager 12 + payload-truncate 12)
pnpm test:fts5   # 12/12 通过
```

## 备注

- LOW L1 / L2 / L3 / L5 / L6 等其余 LOW 项暂未修（a11y / 错误信息脱敏 / POSIX 假设留待后续统一处理）
- LOW L9（image TOCTOU）已顺手在 L9 fileHandle 改动里修了
- 已审过期机制起作用：本批 commit 后续若再改 ipc.ts / SettingsDialog.tsx 等文件，churn 会基于 REVIEW_4 base 重算
- REVIEW_4.md 「关联 changelog」字段已更新为本份 CHANGELOG_23
