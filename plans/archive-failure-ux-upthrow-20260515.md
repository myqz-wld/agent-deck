---
plan_id: "archive-failure-ux-upthrow-20260515"
created_at: "2026-05-15"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/archive-failure-ux-upthrow-20260515"
status: "completed"
base_commit: "b7ba2b2"
base_branch: "main"
parent_observation: "REVIEW_39 / CHANGELOG_112 收口时 R37 caller 仍 active 独立 root cause 双方共识保留为本 follow-up"
final_commit: "3eb439d3d2d701d6d2ffdf0d8445296dd7440e83"
completed_at: "2026-05-15"
---
# archive-failure-ux-upthrow-20260515 — archive caller 失败 UX 上抛 follow-up

## 总目标 & 不变量

REVIEW_39 / hand-off-mcp-teammate-bug-20260515 plan 收口时挖出的**独立正交** HIGH root cause:

R37 caller `024289d4` 实测 lifecycle=active(应被 R37 archive_plan 自动归档但未生效)。双 reviewer R1+R1.5 反驳轮共识 3 类可能场景:

### 场景 A: archive 失败 warn-only 被吞

`baton-cleanup.ts:204-209`:
```ts
try {
  await archiveFn(input.callerSessionId);
  return { teammatesShutdown, archived: 'ok' };
} catch (e) {
  console.warn(...);  // ← 失败被吞,用户感知不到
  return { teammatesShutdown, archived: 'failed' };
}
```

archive 失败 console.warn 出去,但 ok return.archived='failed' 字段透传给 caller **没消费方**(grep 验证 hand-off-session.ts / archive-plan.ts ok return 都包含 archived 字段但 UI / handler 未反应)。

### 场景 B: 旧版本 archive_plan 不归档 caller

R37 archive_plan 在 CHANGELOG_99 / CHANGELOG_109 baton-cleanup 改造**之前**完成 — 老版本 archive_plan 不自动归档 caller。需要 git log 查 archive_plan handler `runBatonCleanup` 引入时间(R37 archive 时间 20260515)。

### 场景 C: unarchiveOnUserSend 拉回 live

`manager.ts:337-341 unarchiveOnUserSend`:
```ts
async unarchiveOnUserSend(sessionId: string): Promise<void> {
  const r = sessionRepo.get(sessionId);
  if (!r || r.archivedAt === null) return;
  await this.unarchive(sessionId);
}
```

jsdoc 明示**仅 IPC AdapterSendMessage 触发(用户从 UI/CLI 显式 sendMessage),mcp tool send_message 不触发**。即用户从 UI 续聊已归档 caller 会被自动 unarchive 拉回 live。

**与 hand_off_session ↳ teammate badge bug 关系**:**正交独立**。CHANGELOG_112 方案 1 fix(spawn handler 不写 baton spawn-link)修了 ↳ teammate badge,但 archive 失败 warn-only 被吞是独立 UX 问题,影响**所有 archive 场景不仅 hand-off**。

**不变量**:
- 所有改动 worktree 内跑,主仓库零污染
- 改完 typecheck + 全套 vitest 必跑
- 不破坏现有 archive 失败容错语义(warn-only 是 by design 让 ok return 不阻塞,本 plan 不应改成 abort);仅加 UX 上抛通道

## 设计决策(待对抗,本 plan in-progress 状态)

1. **可能修法清单(待 R1 反驳轮决策)**:
    - **修法 A**:archive 失败 emit IPC event 让 UI 弹通知(主流方案,与 fatal dialog / pendingTab 同款 UX)
    - **修法 B**:archive 失败时 ok return 加 `userActionable: true` 字段,handler / IPC 拦截时弹 dialog 让用户手动归档
    - **修法 C**:archive 失败时把 caller session 标 `archive_failed_at` 列,UI 角标显示「⚠ 归档失败」+ 右键「重试归档」
    - **修法 D**:archive 失败时退化到 lifecycle=closed(强行 close session 让它从 live 列表消失)— 副作用大不推荐
2. **可能涉及范围**:
    - `src/main/agent-deck-mcp/tools/handlers/baton-cleanup.ts:200-210` 失败 emit
    - `src/main/event-bus.ts` 加 `caller-archive-failed` event
    - `src/renderer/...` 通知 / 角标 UI(取决于修法)
    - 可能涉及 `src/main/store/migrations/` 加 archive_failed_at 列(取决于修法)
3. **场景 B / C 是否需修**:
    - 场景 B(旧版本不归档):pre-existing 状态不可改,只能新版本生效后逐步消化
    - 场景 C(unarchiveOnUserSend):**by design 用户主动续聊**,不修(用户预期就是这样)
    - **本 plan 仅修场景 A(archive 失败 UX 上抛)**

## 步骤 checklist

### Phase 1: 复现 + 排查

- [x] **Step 1.1 — 复现实验** — done by sid `<this-sid>` on 2026-05-15, uncommitted(只读扫描). 现有 `src/main/agent-deck-mcp/__tests__/baton-cleanup.test.ts` case 6/7/8 已**精确复现**三类 archive 失败场景且实测命中 console.warn + `archived='failed'`:
    - case 6 (line 182-212): `getSession` 返回 null (row missing) → `archive='failed'` + warn `cannot archive caller <sid>: not in sessions table` + 不调 archiveFn
    - case 7 (line 214-240): `getSession` throw (DB 异常 fail-safe like SQLite locked) → catch 兜底为 null → 走 row missing 路径 `archive='failed'`
    - case 8 (line 242-269): `archiveFn` throw (FK constraint / sessionManager.archive 失败) → `archive='failed'` + warn `archive caller <sid> failed:` + Error obj
    - **结论**:无需新写复现 test,unit 层场景 A 已 production-grade 完整覆盖
- [x] **Step 1.2 — 现有消费方扫描** — done by sid `<this-sid>` on 2026-05-15, uncommitted(只读扫描). 三层 grep 全 0 消费方:
    - **renderer 端 0**:`grep "archived\s*[:=]\s*['\"](?:ok|failed|skipped)" src/renderer` → No matches
    - **IPC handler 0**:`grep "result\.archived|response\.archived|cleanup\.archived" src/main` → 仅 `archive-plan.ts:155` + `hand-off-session.ts:399` 两处 `archived: cleanup.archived` 透传到 ok return,**无 IPC handler 读 result.archived 触发 UI**
    - **event-bus 0**:`event-bus.ts` 现有 7 个 universal team event(`agent-deck-team-*` / `agent-deck-message-*` / `task-changed` / `summary-added` / `session-*`)无任何 `archive-failed` / `caller-archive` 类事件;`grep "archive-failed|archive_failed|caller-archive" src/main` → No matches
    - **结论**:`archived` 字段从 baton-cleanup 生产 → archive-plan/hand-off-session 透传到 ok return string 字段 → **无人读**(场景 A 假设完全成立 — caller mcp 端拿到字符串字段就扔了,UI 无任何感知)
- [x] **Step 1.3 — 异构对抗 R1 review** — done by sid `<this-sid>` on 2026-05-15. team_name=`archive-failure-ux-r1` 并发 spawn 两 reviewer teammate(reviewer-claude `3fb611ac` / reviewer-codex `48679ea5`)R1 全量 review,reply 完整收集。三态裁决:
    - **共识 HIGH 4 条**: H1 修法 A 推荐 / H2 修法 B 反驳 / H3 修法 C 反驳 / H4 修法 D 反驳(双方角度互异结论一致 = 异构强证据)
    - **单方独有 + 现场验证 5 条 MED**: M1 renderer 无全局 toast 基建(grep 验证仅 NotifySection/controls/SessionDetail 局部 3 处) / M2 notifyUser API + enableSystemNotification setting 现成(visual.ts:14, 29) / M3 K3 SessionHandOffSpawn 同款静默(ipc/sessions.ts:144 走独立 sessionManager.archive 不经 baton-cleanup helper) / M4 window.api.archiveSession 现成(preload/api/sessions.ts:37) / M5 reason 字段区分 row-missing vs archive-throw(双方共识)
    - **LOW P2 follow-up 2 条**: case 5 phase 1 shutdown 通知 / row 存在时写 ActivityFeed SimpleRow 内联提示
    - **reviewer 已 shutdown_session**(messages / events / file_changes / summaries 子表保留,可在后续 REVIEW.md 引用)

### Phase 2: fix

- [x] **Step 2.1 — 用户决策修法 A/B/C/D** — done by sid `<this-sid>` on 2026-05-15. 用户 AskUserQuestion 选定:
    - **修法 A**(双 reviewer 100% 共识)
    - **MVP 路径 = 路径 1+2 组合**:MVP 走路径 1 macOS notifyUser + P2 enhancement 加路径 2 renderer toast + 重试按钮
    - **K3 SessionHandOffSpawn UI hand-off 一起修**(同款静默 ipc/sessions.ts:144,scope 外但 grep 验证存在,避免后续 plan 重复处理)
- [x] **Step 2.2 — 实施 + 守门 test** — done by sid `<this-sid>` on 2026-05-15, uncommitted. Phase 2 MVP 路径 1 + K3 全部落地,typecheck + 全套 vitest (529 pass + 64 skipped SQLite binding ABI 守门)双过。8 文件改动 / 294 lines insert / 29 lines delete:
    - **3a EventMap + IpcEvent**: `src/main/event-bus.ts` 加 `'caller-archive-failed': [{ sessionId, toolName, reason, reasonKind: 'row-missing'|'archive-throw' }]` event;`src/shared/ipc-channels.ts` 加 `IpcEvent.CallerArchiveFailed`(jsdoc 引用本 plan)
    - **3b baton-cleanup emit + test**: `src/main/agent-deck-mcp/tools/handlers/baton-cleanup.ts` 顶部 import eventBus + EventMap 类型,加 `emitArchiveFailed` deps seam,row-missing(line 209-219)+ archive-throw(line 226-238)两处 emit + reason 构造统一(`cannot archive caller <sid>: not in sessions table` / `archive caller <sid> failed: ${errStr}`)。`baton-cleanup.test.ts` case 6/7/8 加 emit 断言 payload schema(sessionId / toolName / reason 模糊匹配 / reasonKind 精确匹配),case 1/3 加 `emitFn not.toHaveBeenCalled` 守门「成功路径不误上抛」
    - **3c K3 helper 抽离 + emit + test**: `src/main/ipc/sessions-hand-off-helper.ts` 加 `archiveSourceSessionWithEmit(sid, deps)` 纯函数 helper(deps 必填 archive + emitArchiveFailed,无 default 实现以避免拉 Electron import 链);`src/main/ipc/sessions.ts` K3 SessionHandOffSpawn 改用 helper + EventMap satisfies 编译期守门 schema 一致性。`sessions.test.ts` 加 3 case(archive ok 不调 emit / archive throw Error / archive throw 非 Error),覆盖 17 tests 全过
    - **3d main bootstrap listener**: `src/main/index.ts` 顶部 import notifyUser,bootstrap eventBus.on('caller-archive-failed') listener 调 `notifyUser({ title: 'Agent Deck 归档失败', body: <reasonKind 区分文案>, level: 'info' })` + `safeSend(IpcEvent.CallerArchiveFailed, payload)`。文案 reasonKind='archive-throw' = 「原会话未归档,可重试归档(<shortSid>...)」;'row-missing' = 「原会话记录不可用,归档未完成」
    - **路径 2 P2 enhancement 留后续 plan**: renderer 端无现成 toast 库(检查 package.json 无 sonner / radix-toast),自建 minimal toast portal 工作量较大;MVP 路径 1 macOS 通知 + IPC channel 已让用户感知失败,P2 toast + 重试按钮独立 plan 实施(本 plan 范围不变量保持简洁)
    - **守门**: `pnpm typecheck` ✅(node + web 双 tsconfig)/ `pnpm exec vitest run` ✅(39 test files passed,529 tests passed,3 skipped 全是 better-sqlite3 binding ABI 守门 by design)/ baton-cleanup.test.ts 10 tests + sessions.test.ts 17 tests 全过

### Phase 3: 收口

- [ ] **Step 3.1 — R2 复审**(若 fix 落地)
- [ ] **Step 3.2 — REVIEW_X.md + reviews/INDEX.md 加行**
- [ ] **Step 3.3 — CHANGELOG_Y.md + changelog/INDEX.md 加行**
- [ ] **Step 3.4 — archive_plan**

## 当前进度

- ✅ 本 plan 文件创建(由 hand-off-mcp-teammate-bug-20260515 plan 收口时建)
- ✅ Phase 1 Step 1.1+1.2 完成(2026-05-15):场景 A 假设 unit test + 全仓 grep 双通道完整验证 — `archived` 字段无 0 消费方,场景 A「archive 失败 warn-only 被吞用户感知不到」**100% 成立**
- ✅ Phase 1 Step 1.3 完成(2026-05-15):R1 异构对抗 + 三态裁决(共识 HIGH 4 + 单方 MED 5 + LOW P2 2 + 现场验证 4 关键假设全过)+ 用户拍板修法 A 路径 1+2 + K3 一起修
- ✅ Phase 2 Step 2.1+2.2 完成(2026-05-15):MVP 路径 1 + K3 全部落地,8 文件改动 / 294 lines insert / 29 lines delete,typecheck + 全套 vitest (529 pass + 64 skipped binding ABI 守门) 双过。改动未 commit,等用户决策 Phase 3 路径
- ⬜ Phase 3 收口:Step 3.1 R2 复审(可选,plan in-progress 状态保留入口)/ Step 3.2 REVIEW + 同步 INDEX / Step 3.3 CHANGELOG + 同步 INDEX / Step 3.4 archive_plan

## 下一会话第一步

**Phase 2 Step 2.2 完整收口,Phase 3 路径在用户决策**。新会话 cold start 后:

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/archive-failure-ux-upthrow-20260515.md` 全文(看 Phase 3 三态拆分)
2. `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/archive-failure-ux-upthrow-20260515")` 进同一 worktree(用 `path` 不是 `name`)
3. `git status` 自检 — 应当看到 8 文件 modified(event-bus.ts / ipc-channels.ts / baton-cleanup.ts / baton-cleanup.test.ts / sessions.ts / sessions-hand-off-helper.ts / sessions.test.ts / main/index.ts)等待 Phase 3 commit
4. **AskUserQuestion 决策 Phase 3 路径**(三选一):
    - **a) 直接进 Step 3.2-3.4 收口**(无 R2 复审):用当前会话的 Phase 1 R1 review + Phase 2 实施作为唯一证据,直接写 REVIEW.md + CHANGELOG.md + archive_plan。优点:省 1 对 reviewer 的 spawn 时间(快约 5-10 min);缺点:实施代码无独立异构 review 守门(只有 R1 review 修法但实施代码没 review)
    - **b) 进 Step 3.1 R2 复审 + Step 3.2-3.4 收口**(推荐):新 team_name=`archive-failure-ux-r2` spawn reviewer-claude + reviewer-codex teammate 异构对抗 review **当前实施代码**(8 文件 diff),三态裁决后再写 REVIEW.md + CHANGELOG.md + archive_plan。优点:实施代码也走异构对抗守门符合本 plan 双 reviewer 文化;缺点:多 5-10 min spawn + 需要再次 reply 收集
    - **c) 暂停 Phase 3 让用户在 SessionDetail 手动验收 K3 hand-off**(实测验证):commit Phase 2 改动 → `pnpm dev` / `pnpm dist` 起本地实例 → 手动触发 K3 hand-off 让 archive 失败(模拟方法:session-repo FK 加 fake 约束 / 用户在 hand-off spawn 后手动锁 session)→ 验证 macOS 系统通知 + IPC 上抛 → 通过后再回 Phase 3。优点:有真实环境守门 production-grade 信心;缺点:模拟 archive 失败本身有难度,且本 plan 已 unit test 全覆盖 ROI 不一定高
5. 按用户决策跑对应路径
6. Step 3.4 调 `mcp__agent-deck__archive_plan({ plan_id: 'archive-failure-ux-upthrow-20260515', worktree_path: '/Users/apple/Repository/personal/agent-deck/.claude/worktrees/archive-failure-ux-upthrow-20260515', base_branch: 'main' })` 收口

## 关联

- 来源 plan: [`plans/hand-off-mcp-teammate-bug-20260515.md`](hand-off-mcp-teammate-bug-20260515.md)(收口时挖出本独立 root cause)
- 来源 review: [`reviews/REVIEW_39.md`](../reviews/REVIEW_39.md) HIGH-3 R37 caller 仍 active 独立正交 root cause
- 来源 changelog: [`changelog/CHANGELOG_112.md`](../changelog/CHANGELOG_112.md) 「不修 §与本 bug 正交的独立 root cause」节

## 已知踩坑

- **archive 失败 warn-only 是 by design**:让 ok return 不阻塞 caller 路径,**不应改成 abort**(会让 hand-off / archive_plan 因 archive 失败而完全失败,破坏现有 baton 单向交接 / plan 归档容错语义)。仅加 UX 上抛通道
- **场景 B / C 不修**:旧版本不可改 + unarchive 是 by design 用户主动续聊
- **R37 caller `024289d4` 当前实测仍 active**:等本 plan 修完后,用户手动归档(应用 → 右键 archive)即可清理掉它,不需要等 fix 自动归档
