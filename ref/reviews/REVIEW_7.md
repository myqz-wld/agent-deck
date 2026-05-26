---
review_id: 7
reviewed_at: 2026-04-25
expired: false
skipped_expired:
---

# REVIEW_7: CHANGELOG_24-29 断连自愈 + fork 兜底 + HistoryPanel 周边周期复审

## 触发场景

最近 7 天 6 commits（`c182377` → `4088f44`）连续修「断连自愈 + CLI fork 兜底 + HistoryPanel 跟随 rename / unarchive」：CHANGELOG_24-28 + 4 个 CHANGELOG_29 微调（archived 自动 unarchive + HistoryPanel listener 自动 reload + 内 / 外标签 + rename 后自动切 live view）。3 个改动热区文件按 CLAUDE.md「已审文件过期」机制全部命中：

| file | LOC | churn vs REVIEW_6 base | distinct commits | 触发 |
|---|---|---|---|---|
| `src/main/adapters/claude-code/sdk-bridge.ts` | 1440 | +180/-120 | 3 | distinct commits ≥ 3 |
| `src/main/session/manager.ts` | 478 | +89/-126 | 4 | commits ≥ 3 + churn 突增 |
| `src/renderer/components/HistoryPanel.tsx` | ~280 | +140/-80 | 3 | distinct commits ≥ 3 |

未审核心文件：**无**（REVIEW_1-6 已全覆盖）。周期复审 + 7 个 Phase 1 探查可疑点统一对抗。

## 方法

**双对抗配对**（CLAUDE.md「决策对抗」节）：
- A 路：Claude Code Opus 4.7 xhigh subagent (Explore) × 4 批并发 background
- B 路：外部 codex CLI gpt-5.4 xhigh × 4 批并发 background（`timeout: 600000`）

**4 批拆分**（按 CLAUDE.md「单批 ≤10 文件 / prompt ≤30 行」）：
- Batch 1: `sdk-bridge.ts` recoverAndSend 热区（行 580-720）+ consume fork detection（行 425-440 / 1170-1190）
- Batch 2: rename / 子表迁移端到端链路（manager + session-repo + event-repo + session-store + App.tsx）
- Batch 3: HistoryPanel listener / debounce / 内外标签 + preload facade
- Batch 4: 字符串匹配残留 + FTS5 上链 + SettingsSet apply* + normalizeCwd / listener 解绑

**范围**：实际审到 9 个文件。

```text
main:
  - sdk-bridge.ts (recoverAndSend + consume fork detection)
  - session/manager.ts (renameSdkSession / unarchive / claim 体系)
  - store/session-repo.ts (rename SQL + listSessionHistory FTS5)
  - store/event-repo.ts (子表 FK 一致性)
  - ipc.ts (SettingsSet apply*)
renderer:
  - App.tsx (historySession 同步 + onSessionRenamed listener)
  - components/HistoryPanel.tsx (debounce + listener + 内外标签)
  - stores/session-store.ts (renameSession 7 Map 对齐)
preload:
  - index.ts (onSessionRenamed / onSessionUpserted facade)
```

**机器可读范围**：

```review-scope
src/main/adapters/claude-code/sdk-bridge.ts
src/main/ipc.ts
src/main/session/manager.ts
src/main/store/event-repo.ts
src/main/store/session-repo.ts
src/preload/index.ts
src/renderer/App.tsx
src/renderer/components/HistoryPanel.tsx
src/renderer/stores/session-store.ts
```

**约束**：跳过 CHANGELOG_16/18/22/23 已修过的项（payload-truncate UTF-8 / SettingsSet rollback / FTS5 alias MATCH / RECENT_LIMIT 对齐 等）；输出按 HIGH/MED/LOW 分级。

## 三态裁决结果

### ✅ 真问题

| # | 严重度 | 文件:行号 | 问题 | A | B |
|---|---|---|---|---|---|
| H1 | HIGH | `sdk-bridge.ts:672-677` | `for (const [sid, internal] of this.sessions.entries()) if (internal.cwd === rec.cwd) { newRealId = sid; break; }` 推断 newRealId 不安全；同 cwd 已存在别的 SDK 会话时取 first 可能取错 → OLD_ID 的 events/file_changes/summaries 子表被错迁到不相关的 NEW_ID。注释说「最新」但代码取 iteration first | HIGH | HIGH |
| M1 | MED | `sdk-bridge.ts:678-685` | post-fallback `releaseSdkClaim(sessionId) + renameSdkSession(sessionId, newRealId)` 缺 try/catch；OLD claim 已释放但 rename 抛错时状态不一致，无补偿 | HIGH | MED |
| M2 | MED | `HistoryPanel.tsx:78-94` | listener `useEffect(..., [])` 闭包固定首次 mount 时 reload 引用，reload 闭包又捕获 filters → 用户改 filter 后 rename/upsert 触发的 listener reload 仍用旧 filters；reqIdRef 只保证「后发赢」不能保证「后发用最新 filters」 | HIGH | MED |
| M3 | MED | `manager.ts:406-412` + `sdk-bridge.ts:1182-1183` | renameSdkSession 不内聚处理 sdkOwned claim 转移；fork 路径 `releaseSdkClaim(resumeId) + renameSdkSession(resumeId, realId)` 后到 createSession 行 453 才 `claimAsSdk(realId)` → 窗口（fork rename → onFirstId → createSession 走完）内 NEW_ID 未 claim，hook 通道若抢先 NEW_ID 事件会被 ingest 走「未 claim」分支造另一条 record | — | HIGH (现场核实降 MED) |
| M4 | MED | `manager.ts:409-411` | `eventBus.emit('session-renamed') → emit('session-upserted')` 跨进程 webContents 顺序依赖 IPC 队列序；renderer 若 upsert 先到 → `store.sessions.set(toId, newRec)` 后 rename 调 `moveMapKey(toId, toId)` 拿不到 fromId 旧 by-session 数据 → recentEvents/summaries/pending 等 7 张 Map 数据丢失 | HIGH | MED |
| L1 | LOW | `App.tsx:85-99` | `setHistorySession((prev) => { setView('live'); select(to); return null; })` updater callback 内调副作用；StrictMode 开发态双调 updater，setView/select 各 2 次（最终 state 一致但违反 React 反模式） | MED | LOW |
| L2 | LOW | `HistoryPanel.tsx:166-174` | 「内/外」标签 `s.source === 'sdk' ? '内' : '外'` 二元判 + tooltip 固定写「外部终端 CLI」；其他 source 值（hook/codex 等）被归到「外」+ tooltip 误导 | MED | LOW |
| L3 | LOW | `ipc.ts:294-302` | SettingsSet 9 个 `apply*` + 9 个 rollback `apply*` 需手维护两份对称列表；新增 setting 字段易漏 apply 导致「能改但不生效」 | MED | LOW |
| L4 | LOW | `sdk-bridge.ts:1172-1174` | 注释说「rename 必须在 createSession 行 465 emit session-start 之后（manager 已 ensure 了 NEW_ID record）」，实际 fork rename 在 1182 (consume 内) → onFirstId → waitForRealSessionId resolve → createSession 行 467 emit session-start，rename 在 session-start 之前。`sessionRepo.rename` 行 183-218 对 toExists=false 走 INSERT 复制 OLD record → 迁子表 → DELETE OLD 路径行为正确，仅注释误导维护者 | — | HIGH (现场核实降 LOW) |

### ❌ 反驳（被对抗或现场核实证伪）

| 报告方 | 报项 | 反驳依据 |
|---|---|---|
| A Batch 3 | `HistoryPanel.tsx:46,50,52-54` setLoading 卡死 HIGH | B 反驳成立：`return` 不绕过 finally；仅过期请求不清 loading（cur ≠ reqIdRef.current 时 finally 内 if 不进），最终最新 reload 完成时 cur === reqIdRef.current 触发 `setLoading(false)`。loading 状态正确反映「正在等最新请求」语义 |
| A Batch 2 | `session-repo.ts:212-214` file_changes 缺 UPDATE 迁移 HIGH | B 反驳 + 现场核实：`session-repo.ts:213` `db.prepare('UPDATE file_changes SET session_id = ? WHERE session_id = ?').run(toId, fromId)` 已迁移，包在 `db.transaction()` 事务内 |
| B Batch 1 | `sdk-bridge.ts:616-621` unarchive fire-and-forget MED | 现场核实 `manager.ts:342-348` `unarchive(sessionId): void` 是同步方法（sessionRepo.setArchived sync + eventBus.emit sync），无 Promise 可 await |
| B Batch 1 | `sdk-bridge.ts:1172-1186` fork rename 顺序与注释不符 HIGH | 现场核实 `sessionRepo.rename` 行 183-218 对 toExists=false 走 INSERT 复制 OLD record → 迁子表 → DELETE OLD 路径，行为正确；仅注释 cosmetic 错误，降 LOW（L4） |
| A Batch 1 | `sdk-bridge.ts:590-601` inflight 第二条等待者递归 MED | B 反驳「不会无限循环」成立；A 路本意也只说「重入」非「无限」。inflight 在 finally 已 delete，下一次进 recoverAndSend 是新一轮，最差情况同 sessionId 失败两次抛同样错给 IPC，行为合理 |
| A Batch 1 | `sdk-bridge.ts:634-641` 占位 message OLD sessionId emit fork 顺序 MED | B 反驳成立：fork 时 `sdk-bridge.ts:1182-1183` `renameSdkSession` 把 OLD_ID 的 events 子表（含占位 message）整体迁到 NEW_ID，UI 看到的是连续记录 |

### ⚠️ 部分共识（双方都看到现场但严重度 / 角度不同）

| 现场 | A 视角 | B 视角 | 主裁决 |
|---|---|---|---|
| HistoryPanel 内 / 外标签 | MED「数据不准」 | LOW「cosmetic UX」 | **LOW**（不引数据 corruption） |
| reload stale closure | HIGH「数据不一致」 | MED「体感偏差」 | **MED**（用户改 filter 时 deps reload 已先正确刷新；listener 后续 stale reload 是体感 bug 不是数据 corruption） |
| App.tsx setState updater | MED「反模式严重」 | LOW「StrictMode dev 双调」 | **LOW**（现场核实最终 state 一致；setView/select 第二次 noop；但仍建议修） |

## 修复（待落地，参考 CHANGELOG_30）

### HIGH
1. **`sdk-bridge.ts:663-687`** — recoverAndSend post-fallback 直接用 `createSession` 返回值替代 `entries()` 反查 newRealId；额外把 rename 包 try/catch 加错误透传 / 补偿（H1 + M1 一起修）

### MED
2. **`HistoryPanel.tsx:78-94`** — listener 内不直接调 reload 闭包；改用 `setFilters((f) => ({ ...f }))` 触发现有 deps useEffect 自然 reload（不会 stale），或用 ref 持 filters 后 reload 内读 ref（M2）
3. **`manager.ts:406-412` + `sdk-bridge.ts:1182-1183`** — `renameSdkSession` 内聚处理 claim 转移（内部自动 `releaseSdkClaim(fromId)` + `claimAsSdk(toId)`），调用方不再手工管 claim；消除 fork 路径微窗口（M3）
4. **`manager.ts:409-411` + `session-store.ts:405-433`** — 颠倒 emit 顺序为 `upsert → renamed`，让 renderer store.upsertSession 先建 toId record，再 renameSession 迁 by-session Map；或 renderer `renameSession` 加 defensive：toId 已有时合并 by-session 数据而非覆盖（M4）

### LOW
5. **`App.tsx:85-99`** — `setHistorySession` updater 仅决策 prev → null/prev，把 setView('live') / select(to) 副作用挪到 useEffect 监听 historySession.id 变化（L1）
6. **`HistoryPanel.tsx:166-174`** — 「内/外」标签按 source 值多分支映射 + tooltip 按实际 source 显示（L2）
7. **`ipc.ts:294-302`** — apply/rollback 对称表加注册表 + 编译期 `Required<AppSettings>` 断言（L3）
8. **`sdk-bridge.ts:1172-1174`** — 修注释正确描述 fork rename 实际顺序（在 session-start 之前）+ 说明 sessionRepo.rename 对 NEW_ID 不存在时走 INSERT 复制 OLD record 的语义保留（L4）

## 关联 changelog

- [CHANGELOG_29.md](../changelog/CHANGELOG_29.md)：补描述 4 个微调 commits（c182377 + 93dac34 + e34cb3e + 9dd4698）—— 本 review 触发「为这 4 个 commit 补 changelog」
- [CHANGELOG_30.md](../changelog/CHANGELOG_30.md)：本次 REVIEW_7 修复落地（H1 + M1-M4 + L1-L4）

## Agent 踩坑沉淀

本次 review 提炼出 3 条 agent-pitfall 候选（进 `.claude/conventions-tally.md`「Agent 踩坑候选」section）：

1. **「entries 反查 + break first 推断 latest」反模式**：Map 迭代顺序虽是插入顺序，但「同 cwd 多 SDK 会话」时 first iteration 不等于 latest；应该直接用上游函数返回值，不要事后反查（H1 教训）。
2. **「跨进程 emit 顺序依赖未文档化的 IPC 队列序」反模式**：renderer 端 store action 应对乱序鲁棒（rename / upsert 任意顺序到达不破坏 by-session 数据），不依赖发端顺序（M4 教训）。
3. **「setState updater callback 内副作用」反模式**：updater 必须 pure，setView / select 等副作用挪 useEffect 监听依赖项变化（L1 教训）。
