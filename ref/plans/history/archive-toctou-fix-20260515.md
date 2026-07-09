---
plan_id: "archive-toctou-fix-20260515"
created_at: "2026-05-15"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/archive-toctou-fix-20260515"
status: "completed"
base_commit: "1456824"
base_branch: "main"
parent_observation: "REVIEW_42 §已知 follow-up 1+2+3 数据层耦合一次性 review/test 最高效(MED race + LOW probe-throw + INFO TOOL_DISPLAY_NAME union)"
final_commit: "9f36c4382e3fc5ec787a859afeb4c7454be859f2"
completed_at: "2026-05-15"
---
# archive-toctou-fix-20260515 — K3/baton archive helper TOCTOU race + reasonKind union 扩展 + TOOL_DISPLAY_NAME union narrow

## 总目标 & 不变量

REVIEW_42 §已知 follow-up 三条数据层耦合一次性收口:

1. **MED race window**(R3 双方共识): K3 `archiveSourceSessionWithEmit` + mcp `baton-cleanup` 两个 helper 都有同款 TOCTOU race — `getSession` sync 探针 OK 后到 `await deps.archive(sid)` 之间至少一个 microtick(`await Promise.resolve()` 等),lifecycle scheduler / 用户手动 close / DB reaper 任一可在窗口内删 row → `setArchived` 裸 UPDATE 不查 `.changes` 对缺失 row silent resolve → `sessionManager.archive` 拿 updated == null 只是不 emit `session-upserted` 不抛错 → helper 走 archive ok 不 emit `caller-archive-failed` → 用户完全无感知 row 已被删
2. **LOW probe-throw 隐藏 UI 重试**(R2 reviewer-codex): `getSession` 抛错(SQLite locked / DB read failure)不等价于 row 不存在,重试可能有效。但当前两个 helper 走 try/catch 兜底 null → 触发 `reasonKind='row-missing'` 路径,文案走「记录不可用」,P2 renderer 也会按 `row-missing` 不展示重试按钮
3. **INFO TOOL_DISPLAY_NAME union narrow**: `Record<string, string>` 软兜底,加新 emit 触发点忘加映射时 fallback 到 raw 字符串(IPC channel 内部名 'SessionHandOffSpawn' 暴露)。EventMap toolName 升级 union(`'archive_plan' | 'hand_off_session' | 'SessionHandOffSpawn'`)+ `Record<KnownToolNames, string>` 强制完整覆盖,加新触发点编译期 fail

**不变量**(本 plan 强约束):
- 所有改动 worktree 内跑,主仓库零污染(EnterWorktree path 路径已切)
- 改完 typecheck + 全套 vitest 必跑(better-sqlite3 ABI skip 守门 by design)
- **archive 失败 warn-only 是 by design**(let ok return 不阻塞 caller),**仅加 setter 层 throw + helper 转 emit 通道**,不改 mcp tool / IPC handler 的 ok return 容错语义
- helper 抽离的 sessions-hand-off-helper.ts 和 baton-cleanup.ts 行为对称(同款修法 + 同款 reasonKind union)
- 不破坏 unarchive 路径(setArchived 取消归档 row missing 也合理 throw,caller 走兜底 try/catch 转 console.warn)

## 设计决策(待 Phase 1 R1 异构对抗 review)

### 待对抗候选修法

#### 修法 A — `setArchived` 检查 `.changes === 1` throw(主推)

```ts
// archive.ts (修后)
export function setArchived(id: string, ts: number | null): void {
  const result = getDb().prepare(`UPDATE sessions SET archived_at = ? WHERE id = ?`).run(ts, id);
  if (result.changes !== 1) {
    throw new Error(`setArchived no-op: session ${id} not found in sessions table`);
  }
}
```

**优点**:
- SQL 单点 setter,silent no-op 是 footgun — throw 让 caller 决定如何处理(语义最纯粹)
- 同时修 archive + unarchive 两条路径(unarchive row missing 也是 caller 应当感知的状态)
- caller 链尾端 `setArchived` 是 ground truth,任何时刻 `.changes === 0` 就是 race window 触发
- 修法位置 1 处(archive.ts:19-21),影响通过 caller 链自然透传

**牵连影响**(必须全审计 + 加 try/catch):
- `sessionManager.archive` (manager.ts:296-306): 必须 try/catch + emit `caller-archive-failed` reasonKind='row-missing' / re-throw 让 caller 感知?
- `sessionManager.unarchive` (manager.ts:308-318): 必须 try/catch + console.warn(unarchive 失败影响小,无 emit 上抛通道)
- `unarchiveOnUserSend` (manager.ts:337-341): 已经 sessionRepo.get 探针,但仍需考虑 archive throw bubble
- IPC SessionArchive handler (ipc/sessions.ts:40): `await sessionManager.archive(...)` 现 ok return,bubble throw 会让 IPC 报错。需要决定是 OK 还是兜底

#### 修法 B — `sessionManager.archive` 反查 `setArchived` 后 row null throw

```ts
// manager.ts:296-306 (修后)
async archive(sessionId: string): Promise<void> {
  sessionRepo.setArchived(sessionId, Date.now());
  const updated = sessionRepo.get(sessionId);
  if (!updated) {
    throw new Error(`sessionManager.archive no-op: session ${sessionId} not in sessions table after setArchived`);
  }
  eventBus.emit('session-upserted', updated);
  await archiveTeamsIfOrphaned(sessionId);
}
```

**优点**:
- scope 比 (a) 小 — 只影响 archive 路径不影响 unarchive(unarchive 同款 race 但概率/影响更小)
- 修法位置 1 处,影响范围已是 sessionManager.archive 的 3 个 caller(IPC / K3 / mcp baton-cleanup)

**缺点**:
- unarchive 同款 race 不修(`setArchived(sid, null)` 也对缺失 row silent resolve,虽然 unarchive 失败影响小)
- 语义不如 (a) 一致(setter 层是 SSOT,反查是 service 层加补)

#### 修法 C — 接受 race window 显式文档,不改代码

**优点**:
- production 触发概率低(lifecycle scheduler 周期 5min / 用户手动 close 同时归档罕见)
- 工作量最小

**缺点**:
- silent miss 是真 bug,REVIEW_42 R3 双方已共识必修
- 留 race window 在,后续触发再修一次累积技术债

### reasonKind union 扩展(LOW probe-throw)

当前 EventMap `'caller-archive-failed'` payload reasonKind union 2 个值:
- `'row-missing'`: sessionRepo.get 返回 null
- `'archive-throw'`: archive 函数抛错(FK constraint / DB locked)

扩展后 3 个值:
- `'row-missing'`: getSession 返回 null(row 真不存在)
- `'probe-throw'`: getSession 自身抛错(DB locked / read failure / SQLite busy 等可能可重试,**新增**)
- `'archive-throw'`: row 存在 archiveFn 抛错

**修法**:
- `event-bus.ts` EventMap 'caller-archive-failed' payload union 扩展 + jsdoc 补 'probe-throw' 描述
- `baton-cleanup.ts` getFn 抛错路径拆出来 emit `reasonKind='probe-throw'`(不再走 `callerRow = null` 通道)
- `sessions-hand-off-helper.ts` 同款拆分
- `main/index.ts` listener case 加 'probe-throw' 文案(「DB 异常,可重试归档」)

### TOOL_DISPLAY_NAME union narrow(INFO 3)

当前:
```ts
const TOOL_DISPLAY_NAME: Record<string, string> = {
  archive_plan: 'plan 归档',
  hand_off_session: '会话接力',
  SessionHandOffSpawn: '会话接力',
};
```

修后:
```ts
// event-bus.ts
'caller-archive-failed': [{
  sessionId: string;
  toolName: 'archive_plan' | 'hand_off_session' | 'SessionHandOffSpawn';
  reason: string;
  reasonKind: 'row-missing' | 'probe-throw' | 'archive-throw';
}];

// main/index.ts
type CallerArchiveFailedToolName = EventMap['caller-archive-failed'][0]['toolName'];
const TOOL_DISPLAY_NAME: Record<CallerArchiveFailedToolName, string> = {
  archive_plan: 'plan 归档',
  hand_off_session: '会话接力',
  SessionHandOffSpawn: '会话接力',
};
```

加新 emit 触发点忘加 TOOL_DISPLAY_NAME 条目时 tsc 编译期 fail(`Type 'X' is not assignable to type 'CallerArchiveFailedToolName'`)。

### 三处修法耦合关系

- 修法 A/B 是 race window 解(必选其一)
- reasonKind 扩展独立但同源(都改 EventMap)
- TOOL_DISPLAY_NAME union 顺手做(EventMap toolName narrow + Record narrow,trivial polish)

R1 review 决策修法 A vs B,然后实施 Phase 2 一并 reasonKind + union narrow。

## 步骤 checklist

### Phase 1: 修法决策(R1 异构对抗)

- [ ] **Step 1.1 — R1 异构对抗 review** — team_name=`archive-toctou-r1` 并发 spawn reviewer-claude + reviewer-codex teammate(应用 SKILL `agent-deck:deep-code-review` 编排)。Scope: 修法 A vs B vs C 取舍 + reasonKind 'probe-throw' 是否合理 + TOOL_DISPLAY_NAME union narrow 副作用评估
- [ ] **Step 1.2 — 三态裁决 + 用户决策** — R1 reply 收集,共识修法落地,争议项走反驳轮 / 现场验证

### Phase 2: 实施 + 守门

- [ ] **Step 2.1 — 实施修法 A 或 B** — 按 R1 决策落地 race window fix
- [ ] **Step 2.2 — reasonKind 'probe-throw' 推全链路** — EventMap + baton-cleanup + sessions-hand-off-helper + main/index.ts listener
- [ ] **Step 2.3 — TOOL_DISPLAY_NAME union narrow** — EventMap toolName union + Record<KnownToolNames, string>
- [ ] **Step 2.4 — test 加守门** — baton-cleanup.test.ts + sessions.test.ts 加 probe-throw case + race window race scenario(setArchived no-op throw 可单测验证)
- [ ] **Step 2.5 — typecheck + vitest 双过** — pnpm typecheck(node + web) + pnpm exec vitest run
- [ ] **Step 2.6 — commit Phase 2 实施** — single commit + descriptive message(scope: race + reasonKind + union narrow)

### Phase 3: R2 复审

- [ ] **Step 3.1 — R2 异构对抗 review** — team_name=`archive-toctou-r2` 同对 reviewer 复用 mental model,scope = Phase 2 commit diff
- [ ] **Step 3.2 — R2 三态裁决 + fix** — 真问题修 + 反驳轮 / 现场验证

### Phase 4: 收口

- [ ] **Step 4.1 — REVIEW_43.md + reviews/INDEX.md 加行** — 三态裁决全文 + 异构对抗轨迹
- [ ] **Step 4.2 — CHANGELOG_119.md + changelog/INDEX.md 加行** — 引用 REVIEW_43,不抄全 plan
- [ ] **Step 4.3 — ExitWorktree(action: keep) + archive_plan tool** — 按 user CLAUDE.md §Step 4 完成路径

## 当前进度

- ✅ 本 plan 文件创建(2026-05-15,sid `<this-sid>`)
- ⬜ Phase 1 R1 review
- ⬜ Phase 2 实施
- ⬜ Phase 3 R2 review
- ⬜ Phase 4 收口

## 下一会话第一步

新会话 cold start:

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/archive-toctou-fix-20260515.md` 全文(看当前阶段 + 已踩坑)
2. `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/archive-toctou-fix-20260515")` 进同一 worktree(用 `path` 不是 `name`)
3. `git status` + `git log --oneline -3` 自检 — HEAD 应在 base_commit `1456824` 或之后
4. 按当前 phase checkbox 推进:
   - Phase 1 未完成 → spawn R1 reviewer team(`agent-deck:deep-code-review` SKILL 帮忙编排)
   - Phase 2 未完成 → 按 R1 决策实施
   - Phase 3 未完成 → spawn R2 reviewer team
   - Phase 4 未完成 → 写 REVIEW + CHANGELOG + INDEX,ExitWorktree + archive_plan

## 关联

- 来源 review: [`reviews/REVIEW_42.md`](../../../reviews/REVIEW_42.md) §已知 follow-up MED race + LOW probe-throw + INFO TOOL_DISPLAY_NAME union
- 来源 changelog: [`changelog/CHANGELOG_118.md`](../../../changelogs/CHANGELOG_118.md) §❓ 不修留 follow-up plan
- 上游 plan: [`plans/archive-failure-ux-upthrow-20260515.md`](../../../plans/archive-failure-ux-upthrow-20260515.md) (已 archived,本 plan 是其 follow-up)

## 已知踩坑

- **修法 A 让 archive 路径 IPC handler bubble throw**: `ipc/sessions.ts:40` `await sessionManager.archive(...)` 当前不 try/catch,如果 archive throw 会让 IPC 报错回 renderer。需要在 R1 决策时考虑两种应对:
  - (a) IPC handler 加 try/catch 转 ok return + emit `caller-archive-failed` reasonKind='row-missing'(unified UX,但 IPC handler 也有 emit 责任)
  - (b) 让 IPC bubble — renderer.window.api.archiveSession 失败 toast(用户主动归档失败本身就是 UX 信号,bubble 比 swallow 更合适)
  - (c) 选 (b) 路径但 IPC handler 加 catch + emit + console.warn 记录原因(平衡)
- **修法 B 不修 unarchive 同款 race**: 后续触发再修一次累积技术债;但 unarchive 失败影响小(用户预期是「取消归档」,不存在 row 等价于「已经不在归档列表」),可接受
- **`setArchived(sid, null)` 取消归档**: 修法 A 改后取消归档撞 row missing 也 throw,需审 unarchive caller 链:
  - `sessionManager.unarchive` (manager.ts:308): try/catch + console.warn(不 emit,unarchive 失败 UX 不通知)
  - `recoverer.ts:254` (codex-cli) + `:308` (claude-code): try/catch + console.warn(同款语义)
- **race window 单测验证**: 单测 mock setArchived 直接 throw 验证 caller 链感知正确(无需真复现 race),unit 守门即可
- **EventMap union narrow 后向兼容**: 加新 emit 触发点必须先在 EventMap union 加值,否则 tsc 报错。这正是本 follow-up 想要的「编译期守门」效果(✅ feature)
