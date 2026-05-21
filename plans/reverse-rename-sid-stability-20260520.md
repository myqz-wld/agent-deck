---
plan_id: "reverse-rename-sid-stability-20260520"
created_at: "2026-05-20"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/reverse-rename-sid-stability-20260520"
status: "completed"
base_commit: "9893cef"
base_branch: "main"
final_commit: "5c1986c1bb97e5ebe59015011da847e813adf3f0"
completed_at: "2026-05-21"
---
# 反向 rename：sessions.id 对外稳定 / 引入 cli_session_id 列

## 总目标 & 不变量

### 总目标

修复用户报的「resume 会话时 team 会有问题，本质是 session id 变了」现象。
具体表现：
1. **应用启动后给历史会话发新消息** → recoverAndSend 走 jsonl-missing fallback 路径 → sessions.id 从 OLD 变 NEW（rename）→ 实时页面渲染问题
2. **send_message 必须先 list_session** → 外部 caller / wire prefix / teammate SDK conversation 持有 OLD sid，rename 后撞 not found

根因：rename 是「DB / 内部 store」**透明** ID 切换，但「对外暴露的 sid 是 caller 长期持有的稳定身份」—— 两者天然冲突。所有走 caller 长期持有 sid 的路径在 rename 后都会撞 not found。

### 不变量（核心契约）

1. **sessions.id 在整个 lifecycle 内绝不改变**（spawn 后首次落定即冻结）
2. **cli_session_id 列允许变化**（jsonl-missing fallback / fork detect / restart-controller 6 处场景下 UPDATE）
3. **wire prefix `[sid <senderSid>]` 写 sessions.id**（应用稳定身份，不写 cli_session_id）
4. **caller 持有的 sid 永远稳定**（mcp tool / wire prefix / team / SDK conversation 全套不撞）
5. **迟到 hook event 路由**：CLI 子进程飞回的迟到 event 携带 cli_session_id，ingest 入口先 sessionRepo.findByCliSessionId 反查 sessions.id，找不到 + isRecentlyDeleted(cli_session_id) 命中即丢弃

## 设计决策（RFC 2 轮对齐，不再争论）

### D1 schema：加 `sessions.cli_session_id` 列（RFC R1-Q1）

理由：现有 8+ 处反查 `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` / `--resume <sid>` / `consume(realId)` 路径需要拿「CLI 当前 thread sid」。alias 表方案 JOIN 性能 + SQL 啰嗦；纯内存映射方案应用重启后丢失。加列方案 SQL 直观、cli_session_id 持久化、与现有 schema 列扩 pattern（permission_mode / codex_sandbox / claude_code_sandbox / model / extra_allow_write / cwd_release_marker）一致。

*已 spike 1.1-1.4: SDK `--resume <sid>` verbatim 透传到 CLI args (sdk.mjs `if(k)i.push("--resume",k)`) + jsonl 路径 `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` 中 `<sid>` == 文件 body 第一条 record `sessionId` 字段 (5/5 sample 100% match) + encodeClaudeProjectDir 规则与应用层 platform.ts 一致 + SDK 实测铁证存在 forkSession 接口 + CLI 隐式 fork (CHANGELOG_27 实测)*

### D2 sid 生成：spawn 不变，**6 处** 后续 rename 反转（RFC R1-Q2 + spike2 修正）

保留 spawn 路径 tempKey → first realId rename 语义（首次确认 sessions.id），仅在 **6 处** 「已 spawn 后」路径反转：

| file:line | 类型 |
|---|---|
| `recoverer.ts:466` | jsonl-missing fallback rename（claude） |
| `codex/recoverer.ts:339` | jsonl-missing fallback rename（codex） |
| `stream-processor.ts:313` | fork detect（claude） |
| `codex/thread-loop.ts:263` | case 3 post-resume fork rename（codex,future-proof） |
| `restart-controller.ts:189` | restartWithPermissionMode fork rename（claude） |
| `restart-controller.ts:341` | restartWithClaudeCodeSandbox fork rename（claude） |

**spike2 修正**: 原 plan 列 codex restart-controller 路径,但 grep 实证 codex restart-controller 已删 post-rename 防御 block (REVIEW_40 R2 reviewer-codex P3 LOW),L134/136 仅是注释 ref,**无真实 renameSdkSession 调用** → 总计 **6 处** 而非 7 处。

理由：tempKey rename 是 SDK fallback bootstrap 主路径核心机制（REVIEW_5 H4 / REVIEW_7 M3 一系列加固），重写风险大。tempKey 阶段 caller 还没拿到 sid，不算「sid 对外变化」。

*已 spike 2.1-2.6: claude fork 触发条件 (CHANGELOG_27 / REVIEW_6) + 判定逻辑 (stream-processor.ts:305 `if (resumeId !== realId)`) + claude 4 处 + codex 2 处反向 rename 路径精准列表 + codex SDK 实测不支持隐式 fork (recoverer.ts:34) + thread-loop case 3 future-proof 保留*

### D3 修法范围：分 3 阶段 ship（RFC R1-Q3）

| Step | 范围 | 现象覆盖 |
|---|---|---|
| **Step A** | 2 处 fallback rename(claude + codex jsonl-missing)+ schema migration v021 + sessionRepo + sdk-bridge/recoverer SDK options.resume 反查(R1 HIGH-C)+ recentlyDeleted 改造 + ingest 4 态分流 | 80% 价值,覆盖用户报的 2 个现象 |
| **Step B** | fork detect 2 处(stream-processor:313 / codex thread-loop:263) | streaming + resume 下 SDK 隐式 fork |
| **Step C** | restart-controller 2 处(claude restartWithPermissionMode:189 / restartWithClaudeCodeSandbox:341);codex restart-controller 已删 post-rename block 跳过 | close-restart / open-restart |

每阶段一个会话收口(commit + verify + 用户手实验),spike 完成后铺 Step A,spike 不通过回 RFC。

### D4 migration：v021 一次性 backfill（RFC R1-Q4）

`UPDATE sessions SET cli_session_id = id WHERE cli_session_id IS NULL`，bootstrap 单线程 db.transaction 内跑（与 v014 / v017 同款执行模式）。

**cli_session_id 列允许 NULL 的边角**(R1 HIGH-A 修法澄清):
- 反查路径(`findByCliSessionId`)允许 NULL miss 走 fallback,不强假设 NOT NULL
- spawn 主路径 tempKey 阶段 cli_session_id 写 NULL(SDK 还没给 first realId)
- 反向 rename / fork detect 路径 update cli_session_id 必非空(更新到 newRealId)
- 唯一索引允许多 NULL(SQLite 默认行为),非空必唯一

### D5 函数签名：双函数共存(RFC R2-Q1) + 入参拆分(R1 HIGH-C 修法) + bridge identity split(R2 升级)

- 保留 `renameSdkSession(tempKey, realId)`：仅 spawn 路径首次确认 sessions.id（语义不变）
- 新增 `updateCliSessionId(applicationSid, newCliSid)`：用于 **6 处** 反向 rename(语义 = UPDATE 单列 + 触发迟到 event 黑名单)
- **R1 HIGH-C 修法**: bridge/recoverer/restart-controller 层 SDK options.resume 字段入参反查 cli_session_id(详 §A.4-pre S1)
  - caller 对外 API 入参 `opts.resume` **保持是应用 sid**(行为不变,sessions Map key / claimAsSdk / events.sessionId 仍用应用 sid)
  - bridge 内部把 SDK CLI `--resume` 用 `rec.cliSessionId ?? sessionId` 反查(jsonl preflight + SDK options.resume 字段)
- **R2 HIGH-D + HIGH-E 升级**: bridge identity split — bridge 层 internal session metadata 从「单一 sid」重构为「applicationSid + cliSessionId 双轨」(详 §A.4-pre S2-S9 9 条 substep):
  - applicationSid (= sessions.id 应用稳定身份) 主键贯穿 sessions Map / event sid / handle return / MCP token / SDK claim
  - cliSessionId (= CLI 当前 thread sid) 仅作 SDK / CLI 入参侧字段(resume / jsonl preflight / fork detect 比较)
  - jsonl-missing fallback 复用 applicationSid 行 + UPDATE cli_session_id 列,不创建新 row 不 emit session-start

### D6 event chain：保留 session-renamed，触发频率降（RFC R2-Q2）

`eventBus.emit('session-renamed', {from, to})` + IpcEvent.SessionRenamed + renderer 三处 listener 全保留;tempKey rename 仍 emit;**6 处反向 rename 不**emit(sessions.id 没变)。不引入新 event。

### D7 ingest 反查：recentlyDeleted 切 cli_session_id + sessionRepo.findByCliSessionId（RFC R2-Q3,**R3 MED 双方共识修订**: 黑名单分场景双写)

**R3 MED 双方共识修订**: 黑名单语义分两种场景(R2 MED-R2-1 已升级 §A.3,本节同步 reflect):

- **`updateCliSessionId` 活跃路径** (反向 rename 6 处场景): 仅黑 OLD_CLI_ID(applicationSid 不进黑名单 — 应用层仍 active 不可拒)
- **`delete` / `close` / `markRecentlyDeleted` 路径** (会话结束兜底场景): 双写 `{applicationSid, cliSessionId}` 黑名单(反向 rename 后 SDK 尾包用 appSid 来 / hook 尾包用 cliSid 来,黑名单必须双 key 覆盖,REVIEW_4 H1 + REVIEW_12 双保险加固)

ingest 入口 4 态分流:
- `findByCliSessionId(eventSid)` 反查 sessions.id;找到 → 走正常路径(覆写 event.sessionId 为 application sid);找不到 + isRecentlyDeleted(eventSid) 命中 → 丢弃迟到 event(支持 cli sid 和 app sid 维度均能命中);找不到 + 不在黑名单 + cwd 命中 pendingSdkCwds → claim+skip 时序兜底(不变);全没命中 → ensureRecord 建外部 CLI 会话(不变)

*已 spike 3.1-3.9: wire prefix `[sid <senderSid>]` 100% 写 sessions.id (universal-message-watcher/index.ts:112) + send_message handler `fromSessionId: caller.callerSessionId` (sessions.id) + 三种 mcp transport (in-process / HTTP / stdio) 全部不读 cli_session_id + mcp-session-token-map 用 sessions.id 做 key + agent_deck_messages.from_session_id / team_members.session_id 全存 sessions.id + findSharedActiveTeams 走 sessions.id 不撞 cli_session_id 变化*

*已 spike 4.1-4.7: recentlyDeleted Map 结构无需改 schema (key 语义按场景分:活跃路径 cli_session_id / 兜底路径 双写 {appSid, cliSid}) + ingest 入口加 findByCliSessionId 反查 + 4 态分流不破 dedupOrClaim 5 段顺序硬约束 + v021 migration backfill + 唯一索引 trivial 实现 (类比 v020 cwd_release_marker)*

### D8 spike scope：4 个 mini-runner（RFC R2-Q4）

| spike | 内容 | 决定哪个假设 | 实证状态 |
|---|---|---|---|
| **spike1** | 实测 Claude SDK `--resume <cli_session_id>` 契约 + jsonl 路径 `<encoded-cwd>/<cli_session_id>.jsonl` | SDK 调用层契约 | *已 spike 1.1-1.4: ✅ 4/4* |
| **spike2** | 实测 Claude / codex SDK fork detect 触发条件 + fork 后 hook event 携带的 sid | fork detect 比对方向 | *已 spike 2.1-2.6: ✅ + plan §D2 7→6 处修正* |
| **spike3** | grep buildWireBody 看 wire prefix 现状 + 跑真实 reply 流验证 | wire prefix sid invariant | *已 spike 3.1-3.9: ✅ wire prefix 100% sessions.id* |
| **spike4** | mock SIGTERM 飞 hook event 实测迟到 event sid + sessionRepo.findByCliSessionId 反查行为 | recentlyDeleted 切换风险 | *已 spike 4.1-4.7: ✅ 黑名单语义改造可行* |

**spike artifacts**: `<plan-dir>/spike-reports/spike{1-4}-*.md` + `spike{1-4}-runner.mjs` + `spike{1-4}.log`(详 §Step 0.5 spike 节产物归档约定)。

## 步骤 checklist

### Step 0 完成 (Spike) — ✅

- [x] spike1 跑完落 `<plan-dir>/spike-reports/spike1-cli-session-id-resume.md`
- [x] spike2 跑完落 `<plan-dir>/spike-reports/spike2-fork-detect-trigger.md`
- [x] spike3 跑完落 `<plan-dir>/spike-reports/spike3-wire-prefix-sid.md`
- [x] spike4 跑完落 `<plan-dir>/spike-reports/spike4-late-hook-event.md`
- [x] 4 个 spike 结论 inline 回写 plan §设计决策（替换 *待 spike 验证* 标注）

### Step 1.5 Deep-Review — pending (user confirm 后启动)

- [ ] 进 Step 1.5 Deep-Review (kind=plan,paths=[本 plan abs-path]),走 deep-review SKILL 多轮异构对抗
- [ ] Deep-Review 出 finding HIGH 必修 / MED 现场验证 → 修订 plan,直到 reviewer 共识可合
- [ ] user confirm 进 Step 2 EnterWorktree

### Step 2 EnterWorktree — pending (user confirm 后启动)

- [ ] Bash `git -C <main-repo> worktree add -b worktree-<plan-id> <main-repo>/.claude/worktrees/<plan-id>`
- [ ] EnterWorktree(path: <worktree-abs-path>) 进 worktree (避 v2.1.112 stale base bug)
- [ ] 进 worktree 第一件事 `Bash: pwd` 自检 + 验证 HEAD == main repo HEAD

### Step A — schema migration v021 + sessionRepo + bridge SDK 入参拆 + ingest 入口反查改造（80% 价值）

**R3 MED-R3-4 修订(双方共识)**: Step A 改造范围跨 8+ 文件、数百行代码、跨 metadata 重构 / sessions Map mutate / event sid / handle return / token map / jsonl-missing fallback / finalizeSessionStart 等 sub-domain — 单 commit diff 难 review + 失败回滚整片。**实施时拆 6 个 sub-commit ship**(每个 sub-commit 独立可 typecheck + build + test 绿才进下一个;失败可单点回滚不破整片):

**R4 MED 双方共识修订**: A-3/A-5 拆分依赖图调整 — A-3 含 S3 SDK 行为级 mutate 改造(R4 HIGH-R4-1 修订 isNewSpawn 分支保护后)+ S5/S7 已让 handle/event 转 applicationSid,但 S9 finalizeSessionStart 落地前 session-start 仍按 cli sid 写,test 7 / test 11 「无 row id=cli」无法独立成立。**修法**: 把 S9 移到 A-3 atomic patch 内同步落,或 A-3 + A-5 必须同一 atomic patch 后再跑 test 7/11/12-14;A-3 通过判定描述从「无 SDK 行为改动」改成「identity 行为切换 + finalizeSessionStart 同步重构,需最小回归 test 1-2/7/11 相关 fixture / mock / assertion 调整」。

| sub-commit | 范围 | 依赖 | typecheck/test 通过判定 |
|---|---|---|---|
| **A-1** | schema migration v021 + sessionRepo cli_session_id 字段接入 + findByCliSessionId / updateCliSessionId helper | (无) | 无 SDK 行为改动,纯 DB 层;现有 vitest test 全套绿 |
| **A-2** | ingest 4 态分流 + 黑名单双写 (manager.ts:103/255/452 改造) | A-1 | manager-ingest test 加 4 态 + 双写 case |
| **A-3** | bridge identity split S1-S5 / S4b / S7 / S9 (InternalSession 重构 + sessions Map + event sid + handle return + provider/getter 5+ 处 + token map + finalizeSessionStart 函数签名改造) — **R4 MED 修订**: 与 S9 atomic patch 落避免 test 7/11 无法独立成立 | A-2 | identity 行为切换 + 最小回归 test 1-2/7/11 (fixture / mock / assertion 改 InternalSession.applicationSid 字段 / sessions Map key 期望值 fallback case 改 applicationSid / spawn 主路径 mutate sequence 期望值改);implementation-time 修 test 时显式记录改了哪些 assertion + 跑通后才进 A-4 |
| **A-4** | bridge identity split S6 / S8 (fork detect 比较 + jsonl-missing fallback 重写,加 resumeMode 字段) | A-3 | 改 SDK 行为;consume-fork.test.ts + recovery.test.ts 加 test 6/7 case |
| **A-5** | spawn bootstrap test 8/9/10/11/12/13/14/15/16/17 (R6 MED-R6-1 修订: test 范围扩到 10-17 加 R5 + R6 新增 test) + S10 grep matrix 自检 + sub-commit A-3 fix 已含 S9 改造 | A-3 | spawn 主路径 vitest 加 test 10-17 + ingest test 8/9 + S10 grep 4 pattern 0 命中 |
| **A-6** | test 矩阵收口 + 用户手实验 + Step A 整体 commit | A-1..A-5 | 7+ 不变量 test 全跑;用户手实验启动应用给历史会话发消息 sessions.id 不变 |

**收口判定**: 所有 6 sub-commit 均 typecheck + build + test 绿 → Step A 整体 commit 收口;Step B / C 后续基于 A-3+A-4 的 identity split 改造继续。

#### Step A.1 — 加 `sessions.cli_session_id` 列 + 唯一索引 (v021 migration) — sub-commit A-1

- [ ] 新建 `src/main/store/migrations/v021_sessions_cli_session_id.sql`:
  - `ALTER TABLE sessions ADD COLUMN cli_session_id TEXT DEFAULT NULL`
  - `UPDATE sessions SET cli_session_id = id WHERE cli_session_id IS NULL` (一次性 backfill)
  - `CREATE UNIQUE INDEX idx_sessions_cli_session_id ON sessions(cli_session_id)` (允许多 NULL,非空唯一)
- [ ] 修改 `src/main/store/db.ts` 的 migration runner:bumping `EXPECTED_USER_VERSION = 21`
- [ ] migration 注释明示 cli_session_id 可 NULL 边角(D4 已澄清):反查路径走 fallback 不强假设 NOT NULL

#### Step A.2 — sessionRepo 接入 cli_session_id 字段 + 新增 findByCliSessionId / updateCliSessionId

- [ ] 修改 `src/main/store/session-repo/types.ts` Row interface 加 `cli_session_id: string | null` 字段
- [ ] 修改 `src/main/store/session-repo/types.ts` SessionRecord interface 加 `cliSessionId: string | null` 字段(rowToRecord helper 同步)
- [ ] 修改 `src/main/store/session-repo/core-crud.ts:14-87` upsert 函数 INSERT/UPDATE 列清单加 `cli_session_id` (列扩到 21 列)
- [ ] 新增 `src/main/store/session-repo/core-crud.ts` `findByCliSessionId(cliSid: string): SessionRecord | null` SELECT helper
- [ ] 新增 `src/main/store/session-repo/core-crud.ts` `updateCliSessionId(applicationSid: string, newCliSid: string): void` setter helper(D5)
- [ ] 修改 `src/main/store/session-repo/index.ts` re-export 这两个新 helper
- [ ] 修改 `src/main/store/session-repo/rename.ts` cli_session_id 字段写入规则(**R1 MED-F 重写,语义 ≠ cwd_release_marker 不能按 v020 pattern 无条件覆盖**):
  - **toExists=false 分支** (INSERT 主路径,L83-108 列清单扩到 21):
    - **R1 HIGH-A 修法 选项 A**:cli_session_id 字段 hardcode 取 `toId`(spawn 主路径 first realId 即 toId,新 cli_session_id == realId)
    - SQL `INSERT INTO sessions (..., cli_session_id, ...) VALUES (..., ?, ...)` bind `toId`(不复制 fromRow.cli_session_id)
    - 注释明示:spawn 路径 tempKey rename 后 NEW row cli_session_id == realId
  - **toExists=true 分支** (L213-225 边角,recoverAndSend jsonl-missing fallback path):
    - **不**像 cwd_release_marker 无条件按 OLD 覆盖 — NEW 行已存在意味着已走过 spawn first realId 确认,NEW 行 cli_session_id 已是正确 realId
    - 修法:**保留 NEW 行已有 cli_session_id 不覆盖**(SQL 用 `cli_session_id = COALESCE(NEW.cli_session_id, ?)` 守护,或干脆 toExists=true 分支跳过 cli_session_id UPDATE)
    - 注释明示:cli_session_id 是反查 key(有副作用,影响 jsonl 路径 / SDK resume / ingest 反查),不是 marker 字段(无副作用如 cwd_release_marker)
- [ ] **upsert ensure() 新建外部 CLI / session-start record 时**(`manager.ts:191-203` ensure 内):cli_session_id 默认 `sessionId`(应用 sid == cli_session_id 自洽,与 v021 backfill 一致)

#### Step A.3 — ingest 入口加 findByCliSessionId 反查 + 4 态分流(完整明示)

- [ ] 修改 `src/main/session/manager.ts:219` ingest(event) 入口,**4 态分流明示**:
  - **3a** `findByCliSessionId(event.sessionId)` 命中 → 覆写 `event = { ...event, sessionId: appSession.id }` 走原 dedupOrClaim 5 段流程(application sid 作 ingest 入参)
  - **3b** 不命中 + `isRecentlyDeleted(originalEventSid)` 命中 → drop(迟到 hook event 走黑名单)
  - **3c** 不命中 + 不在黑名单 + cwd 命中 pendingSdkCwds → 走原 dedupOrClaim 时序兜底 claim+skip(REVIEW_5 H1 / REVIEW_12 修法不变)
  - **3d** 全没命中 → 走原 ensureRecord 建外部 CLI 会话(现状 fallback 不变)
  - **不变量**: 4 态不破 dedupOrClaim 5 段顺序硬约束 — 3a 后仍走 dedup;3c/3d 完全保留现状逻辑(只在前面加 3a/3b 反查/黑名单分支)
- [ ] 修改 `src/main/session/manager.ts:103` recentlyDeleted Map 注释 `sessionId → deletedAt` 改为 `cli_session_id → deletedAt`(语义记录,Map 类型不动)
- [ ] 修改 `src/main/session/manager-ingest-pipeline.ts` IngestContext.isRecentlyDeleted 接口签名注释明示参数是 cli_session_id

##### **R1 MED-C 修法 + R2 MED-R2-1 升级**: 改造 manager.ts:255 / 452 黑名单 set 调用 — **双写 {applicationSid, cliSessionId}**

**R2 MED-R2-1 升级原因**: R1 修法让 delete/close 路径黑名单只写 cli sid,但反向 rename 后 SDK-side events 映射成 application sid(S4 修法);删除/关闭窗口内 SDK 尾包已经映射为 app sid → `isRecentlyDeleted(appSid)` miss + `findByCliSessionId(appSid)` miss → 3d 复活幽灵 record。原 REVIEW_4/12 防线是「任何来源尾包」都挡,不能只挡 hook cli sid。

- [ ] 修改 `manager.ts:255` `markRecentlyDeleted(sid)`:
  - 当前: `recentlyDeleted.set(sessionId, Date.now())`
  - 改为: `const rec = sessionRepo.get(sessionId); const cliSid = rec?.cliSessionId; const now = Date.now(); this.recentlyDeleted.set(sessionId, now); if (cliSid && cliSid !== sessionId) this.recentlyDeleted.set(cliSid, now);` — **双写 {appSid, cliSid}** 黑名单
  - 注释明示:R1 MED-C + R2 MED-R2-1 双方共识 — 反向 rename 后 SDK 尾包用 appSid 来 / hook 尾包用 cliSid 来,黑名单必须双 key 覆盖
- [ ] 修改 `manager.ts:452` `delete(sid)` 内黑名单 set 同款双写改造:
  - 当前: `this.recentlyDeleted.set(sessionId, Date.now())`
  - 改为: 在 set 前 `const rec = sessionRepo.get(sessionId)`(rec 一定存在 — DELETE 之前);然后 `const now = Date.now(); this.recentlyDeleted.set(sessionId, now); if (rec?.cliSessionId && rec.cliSessionId !== sessionId) this.recentlyDeleted.set(rec.cliSessionId, now);`
- [ ] **updateCliSessionId helper 内黑名单 set 不变** (R1 fix 已对): 仅黑 OLD_CLI_ID(applicationSid 不进黑名单 — 应用层 sid 仍 active 不可拒)
- [ ] **ingest 3b 分流调整 (R2 MED-R2-1 升级)**: `findByCliSessionId(eventSid)` 不命中后,**检查原始 eventSid**(不论 cli sid 还是 app sid 维度):`if (this.isRecentlyDeleted(originalEventSid)) return` — 因为黑名单双写后 appSid / cliSid 都能命中,直接走单一 isRecentlyDeleted 检查即可

#### **新增 §A.4-pre — bridge identity split (R2 反驳轮升级,reviewer 双方共识)**

**核心 design 升级**: bridge 层 internal session metadata 从「单一 sid」重构为「applicationSid + cliSessionId 双轨」。R1 §A.4-pre 仅改 SDK options.resume 入参严重不足 — R2 reviewer-codex HIGH-D + HIGH-E 双方共识必修。

**关键不变量**: applicationSid (= sessions.id 应用稳定身份) 主键贯穿 sessions Map / event sid / handle return / MCP token / SDK claim;cliSessionId / threadId (= CLI 当前 thread sid) 仅作 SDK / CLI 入参侧字段(resume / jsonl preflight / fork detect 比较)。

##### S1 — createSession 接口签名拆 (claude + codex,**R3 HIGH-G 升级**: 加显式 mode 字段 + **R4 MED-R4-1 升级**: 7 种合法/非法组合不变量表 + **R6 HIGH-R6-1 升级**: bridge 内部 effectiveResumeCliSid 兜底)

- [ ] 修改 `src/main/adapters/types.ts` ClaudeCreateOpts:
  - `resume?: string` 字段 jsdoc 明示语义 = applicationSid (caller 对外 API 入参,行为不变)
  - 新增 internal 字段 `resumeCliSid?: string` (recoverer 内部用,caller 不该传 — TS 不强 enforce 但 jsdoc 标注)
  - **R3 HIGH-G 升级**: 新增显式 `resumeMode?: 'resume-cli' | 'fresh-cli-reuse-app'` 字段(默认 `'resume-cli'`),解决 `resumeCliSid: undefined` 双语义冲突
  - **R6 HIGH-R6-1 升级 — bridge 内部 effectiveResumeCliSid 集中兜底 (R7 HIGH-R7-1 修订: 三分支 guard opts.resume)**:
    bridge createSession / createThunk 入口 resolve effective 值统一处理:
    ```ts
    // bridge 内部 (createSession 早期):
    // **R7 HIGH-R7-1 修订**: 三分支显式 guard opts.resume undefined,防 spawn 主路径走 else 分支
    // 撞 sessionRepo.get(undefined)
    const effectiveResumeCliSid =
      opts.resumeMode === 'fresh-cli-reuse-app' ? undefined :  // fresh fallback: SDK 不带 resume
      !opts.resume ? undefined :                                // ← spawn 主路径 guard (opts.resume undefined → undefined)
      (opts.resumeCliSid ?? sessionRepo.get(opts.resume)?.cliSessionId ?? opts.resume);  // normal resume
    // SDK options.resume + jsonl preflight + S6 fork detect compare 全部用 effectiveResumeCliSid
    ```
    **关键 invariant**: caller 传 `opts.resumeCliSid` 时显式优先(高 priority);未传时 bridge 内部反查 sessionRepo.cliSessionId 兜底回填;只有 `'fresh-cli-reuse-app'` 才保持 undefined。S6 fork detect compare 用 `effectiveResumeCliSid !== realId` (而非 `opts.resumeCliSid !== realId`) — 兜底回填后 S6 不再 short-circuit 短路。
    **R7 HIGH-R7-1 修订**: 必须三分支显式 guard opts.resume undefined — spawn 主路径合法组合 (opts.resume undefined + resumeMode='resume-cli' + resumeCliSid undefined) 按字面 2 分支 ternary 会走 else 分支 `sessionRepo.get(opts.resume!)` non-null assertion 撞 runtime undefined → sessionRepo.get(id: string) 入参类型错配。三分支显式 guard 让 spawn 主路径直接落 effectiveResumeCliSid = undefined,与 S1 表第 1 行字面对齐。
  - **R4 MED-R4-1 升级 不变量表 (R6 HIGH-R6-1 修订 effective 列)**: 7 种合法/非法组合(jsdoc 必表格化:
    | opts.resume | resumeMode | resumeCliSid | 路径 | effectiveResumeCliSid (R6) | SDK resume 入参 |
    |---|---|---|---|---|---|
    | undefined | 'resume-cli'(default) | undefined | spawn 主路径 | undefined | 不传 |
    | 非空 | 'resume-cli' | 非空 | normal resume(显式 cli sid) | resumeCliSid | resumeCliSid |
    | 非空 | 'resume-cli' | undefined | normal resume(反查 fallback) | sessionRepo.get(resume)?.cliSessionId ?? resume | effectiveResumeCliSid |
    | 非空 | 'fresh-cli-reuse-app' | undefined | jsonl-missing fallback | undefined | 不传 |
    | undefined | 'fresh-cli-reuse-app' | * | **错误 — runtime guard reject** | - | - |
    | 非空 | 'fresh-cli-reuse-app' | 非空 | **错误 — runtime guard reject** | - | - |
    | undefined | 'resume-cli' | 非空 | **错误 — runtime guard reject** | - | - |
- [ ] 修改 `src/main/adapters/types.ts` CodexCreateOpts 同款字段扩
- [ ] 修改 `src/main/adapters/types.ts` CreateSessionOptionsRaw 加 `resumeCliSid` + `resumeMode` 字段(builder helper 透传给对应 adapter)
- [ ] **R4 MED-R4-1 必加 runtime guard**: bridge createThunk / createSession 入口加 `assertCreateOptsValid(opts)` 函数,检查 7 种组合内 3 种非法状态直接抛错(防 caller 误传静默走错路径)— implementation-time 落,plan-time 注释级
  - **R8 LOW-R8-1 修订**: implementation-time 必须保证执行顺序为 ① `assertCreateOptsValid(opts)` 先跑 (fail-fast 原则) ② effective resolver 后算 — 否则 3 种非法组合会先落 resolver 第 1/3 分支(undefined or 反查)然后才被 guard 抛错,日志位置漂移

##### S2 — InternalSession metadata split (claude + codex,**R3 HIGH-F 升级**: applicationSid 生命周期分两阶段)

**R3 HIGH-F 双方共识必修**: applicationSid 生命周期分两类,不能字面冻结 = tempKey 永久不变(否则破 §不变量 1 line 25「首次落定即冻结」+ §D2 line 41-42「保留 spawn rename 语义」+ §D6 line 92「tempKey rename 仍 emit」三处契约)。

- [ ] 修改 `src/main/adapters/claude-code/sdk-bridge/types.ts` InternalSession:
  - **新增** `applicationSid: string` 主键字段
  - 字段 jsdoc 必明确分两阶段:
    ```
    applicationSid 生命周期分两类:

    【spawn 主路径】(无 opts.resume 起新 SDK thread,resumeMode 无效):
      - ctor 时 applicationSid = tempKey (randomUUID() 临时占位)
      - first realId 到达时 (stream-processor.ts:268-279 / thread-loop.ts:142-154):
        - 调 sessionManager.renameSdkSession(tempKey, realId) 迁 DB row + 子表 (D2 spawn bootstrap rename 保留)
        - internal.applicationSid = realId (切到 first realId,从此冻结)
        - emit session-renamed{from: tempKey, to: realId} (D6 契约)
      - first realId 之后任何 6 处反向 rename 都**不动** applicationSid

    【resume / jsonl-missing fallback / restart-controller 路径】(已有会话):
      - ctor 时 applicationSid = caller 传入 opts.resume (= sessions.id 应用稳定身份)
      - 全生命周期 applicationSid 不变 (6 处反向 rename 仅改 cliSessionId 列)
    ```
  - 现有 `realSessionId: string | null` rename 为 `cliSessionId: string | null` 语义切到 SDK 维度(first realId 写入,反向 rename 时 fork detect 改写)
- [ ] 修改 `src/main/adapters/codex-cli/sdk-bridge/types.ts` 同款:
  - **新增** `applicationSid: string` 主键(jsdoc 同款双阶段化)
  - 现有 `threadId: string | null` 语义保持(已是 SDK 维度)
- [ ] 修改 `makeInternalSession` factory(claude `types.ts:makeInternalSession` + codex 同款) ctor 入参加 `applicationSid`,内部初始化两字段

##### S3 — sessions Map key 用 applicationSid (**R3 HIGH-F + R4 HIGH-R4-1 升级**: spawn 主路径分支保护 + 显式 isNewSpawn guard)

**R3 HIGH-F 修订**: spawn 主路径 first realId 到达时 applicationSid 已切到 realId,sessions.set(applicationSid) 与现有 sessions.set(realId) 字面行为等价。

**R4 HIGH-R4-1 双方共识必修**: 字面 `if (tempKey !== realId)` 不足以区分 spawn 主路径 vs jsonl-missing fallback (resume/fallback 路径 ctor 时 tempKey === applicationSid !== first cli sid 必命中错误 mutate),必须显式 isNewSpawn 分支保护。

- [ ] 修改 `src/main/adapters/claude-code/sdk-bridge/stream-processor.ts:271-279`:
  - **R4 HIGH-R4-1 修订 + R5 HIGH-R5-1 修订**: 显式 isNewSpawn 分支保护伪代码 + else 分支拆细让 DB 写统一走 sessionManager 黑名单链:
    ```ts
    const isNewSpawn = !opts.resume && opts.resumeMode !== 'fresh-cli-reuse-app';

    if (tempKey !== realId) {
      if (isNewSpawn) {
        // spawn 主路径(opts.resume 空 + resumeMode 'resume-cli' 默认):D2 spawn bootstrap rename 保留
        this.ctx.sessions.delete(tempKey);
        this.ctx.sessions.set(realId, internal);
        internal.applicationSid = realId;          // ← spawn 路径 applicationSid 切到 first realId
        internal.cliSessionId = realId;            // 同步设 cli sid
        sessionManager.renameSdkSession(tempKey, realId);  // D2 + D6 emit session-renamed
      } else {
        // resume / fallback 路径 (opts.resume 非空):applicationSid 全程不变 (S2 contract)
        // **R5 HIGH-R5-1 修订**: 只 update internal 字段, DB 写**绝不**直接调 sessionRepo.updateCliSessionId
        // 否则会绕过 sessionManager.updateCliSessionId 的 OLD_CLI 黑名单包装,真实 fork 时 first-id mutation
        // 抢先写 NEW_CLI 覆盖 OLD_CLI → S6 fork detect 调 sessionManager 时 oldCliSid 反查拿到 NEW_CLI →
        // 黑名单丢 OLD_CLI → 迟到 hook event 撞 D7 3b miss 复活幽灵 record (违反不变量 5)
        internal.cliSessionId = realId;

        if (opts.resumeMode === 'fresh-cli-reuse-app') {
          // jsonl-missing fallback: opts.resumeCliSid undefined,S6 fork detect 不触发(opts.resumeCliSid 短路)
          // → DB 写 + OLD_CLI 黑名单交给 sessionManager.updateCliSessionId 让 manager 内部读 oldCliSid 进黑名单
          sessionManager.updateCliSessionId(internal.applicationSid, realId);
        }
        // normal resume 路径 (resumeMode='resume-cli'): DB 写 + 黑名单交给 S6 fork detect:
        // - 无 fork (realId === effectiveResumeCliSid): DB 现 cli_session_id == realId 同值 redundant,不需要写
        // - 真实 fork (realId !== effectiveResumeCliSid): S6 fork detect 触发 sessionManager.updateCliSessionId(走 OLD_CLI 黑名单)
        // - **R6 HIGH-R6-1 修订**: caller 不传 resumeCliSid 时(典型: recoverer.ts:486 normal resume),bridge
        //   内部 effectiveResumeCliSid (S1 R6 升级) 反查 sessionRepo.cliSessionId 兜底回填 — S6 compare 用
        //   effective 值不再 short-circuit;无论 caller 显式传或省略都正确触发 fork detect
      }
    }
    ```
  - jsdoc 必明确: 5 处契约保护 + R5 HIGH-R5-1 时序保护 — DB 写 (sessionRepo.updateCliSessionId) **必须**经 sessionManager 包装,不可直接调,确保 OLD_CLI 黑名单链不断
- [ ] 修改 `src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts:142-154` (spawn 主路径) 同款显式 isNewSpawn 分支保护伪代码 (R4 LOW-R4-1 同步) + R5 HIGH-R5-1 else 分支拆细:
    ```ts
    const isNewSpawn = !opts.resume && opts.resumeMode !== 'fresh-cli-reuse-app';

    if (realId !== tempKey) {
      if (isNewSpawn) {
        // spawn 主路径
        this.ctx.sessions.delete(tempKey);
        this.ctx.sessions.set(realId, internal);
        sessionManager.claimAsSdk(realId);
        internal.applicationSid = realId;
        internal.threadId = realId;
        sessionManager.renameSdkSession(tempKey, realId);
      } else {
        // resume / fallback 路径: R5 HIGH-R5-1 修订同 claude 端
        internal.threadId = realId;
        if (opts.resumeMode === 'fresh-cli-reuse-app') {
          sessionManager.updateCliSessionId(internal.applicationSid, realId);
        }
        // normal resume 路径: DB 写 + 黑名单交给 S6 fork detect (case 3)
      }
    }
    ```
- [ ] 修改 `:259-260` case 3 fork (R3 HIGH-F R3 修订已说 case 3 不在 spawn 主路径, applicationSid 早冻结不动,整段简化为只 update internal.threadId):
  - 整段简化为 `internal.threadId = ev.thread_id` (不 mutate sessions Map — applicationSid 仍是 sessions Map key)

##### S4 — event sid 派发用 applicationSid

- [ ] 修改 `src/main/adapters/claude-code/sdk-bridge/stream-processor.ts:323-324`:
  - 当前: `const sid = realId ?? internal.realSessionId ?? tempKey; translateSdkMessage(this.ctx.emit, sid, m, internal);`
  - 改为: `const sid = internal.applicationSid; translateSdkMessage(this.ctx.emit, sid, m, internal);`
  - 同款 catch 路径 (L340) 改 `const sid = internal.applicationSid;`
  - 同款 finally 路径 (L354) 改 `const sid = internal.applicationSid;`
- [ ] 修改 `src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts:217`:
  - 当前: `sessionId: internal.threadId ?? key`
  - 改为: `sessionId: internal.applicationSid`

##### S4b — applicationSid 贯穿覆盖扩展 (**R4 HIGH-H 双方共识必修**: provider/getter/map access 维度漏点)

**R4 HIGH-H 双方共识必修**: 现有代码多处 `internal.realSessionId ?? tempKey` 在 applicationSid != cliSessionId 下破不变量 3/4(spike3 §3.1/3.4/3.7 + D7 不变量 3 — wire prefix `[sid]` 100% 写 sessions.id;send_message handler / mcp token map / team_members 子表全用 sessions.id 维度)。S2 字段 rename 后字面变 cliSid 维度 — 5+ 处 provider/getter/map access 需要 explicit 改用 applicationSid。

- [ ] 修改 `src/main/adapters/claude-code/sdk-bridge/mcp-server-init.ts:51`:
  - 当前: `const sid = internal.realSessionId ?? tempKey;` (用于 agentDeckTeamRepo.findActiveMembershipsBySession 反查 team_id)
  - 改为: `const sid = internal.applicationSid;`
  - 注释明示: team_members.session_id 列存 sessions.id 维度,反查必须用 applicationSid (spike3 §3.4 实证)
- [ ] 修改 `src/main/adapters/claude-code/sdk-bridge/mcp-server-init.ts:62`:
  - 当前: `() => internal.realSessionId ?? tempKey` (注入 getTasksMcpServerForSession 第 2 入参 = sessionIdProvider)
  - 改为: `() => internal.applicationSid`
  - 注释明示: team-task-* AgentEvent.sessionId 派发必须用 applicationSid (D7 不变量 3)
- [ ] 修改 `src/main/adapters/claude-code/sdk-bridge/mcp-server-init.ts:78`:
  - 当前: `() => internal.realSessionId ?? tempKey` (注入 getAgentDeckMcpServerForSession = callerSessionIdProvider)
  - 改为: `() => internal.applicationSid`
  - 注释明示: caller_session_id args 防伪入参必须用 applicationSid (mcp send_message no-shared-team check 走 sessions.id 维度,spike3 §3.4 实证)
- [ ] 修改 `src/main/adapters/claude-code/sdk-bridge/index.ts:228-232`:
  - 当前: `getSessionId: () => internal.realSessionId ?? tempKey` (注入 makeCanUseTool deps)
  - 改为: `getSessionId: () => internal.applicationSid`
  - 注释明示: canUseTool 内 timeout responder 多处使用 (can-use-tool.ts:139/219/349 emit waiting-for-user event),event sid 必须用 applicationSid 否则 PendingTab 漂浮路由错位
- [ ] 修改 `src/main/adapters/claude-code/sdk-bridge/stream-processor.ts:108-116` createUserMessageStream:
  - 当前: `const key = internal.realSessionId ?? tempKey; if (!this.ctx.sessions.has(key)) return;`
  - 改为: `const key = internal.applicationSid; if (!this.ctx.sessions.has(key)) return;`
  - 注释明示: sessions Map key 在 R3 fix S3 后是 applicationSid 维度,createUserMessageStream 流式 prompt 喂 SDK 主循环必须用 applicationSid 才能命中(否则 fallback 路径用户 message 断流 — 这是用户报告 bug 触发场景之一)
- [ ] **R5 MED-R5-1 必加** 修改 `src/main/adapters/claude-code/sdk-bridge/pending-cancellation.ts:95-96`:
  - 当前: `const realIdForEmit = internal.realSessionId ?? sessionId; cancelPendingAndEmit(internal, realIdForEmit, emit);`
  - 改为: `const realIdForEmit = internal.applicationSid; cancelPendingAndEmit(internal, realIdForEmit, emit);`
  - 注释明示: cancellation event sessionId 必须用 applicationSid,与 S4b L4 弹窗初始 emit (can-use-tool.ts:139/219/349 走 getSessionId() = internal.applicationSid 维度) 维度对齐 — PendingTab(appSid) 路由 cancellation 才能清掉 pending 项;反向 rename 后 internal.cliSessionId 是 cli sid 维度,close cleanup 用 cli sid 发 cancellation event 会让 PendingTab 漂浮 pending 项无人清(同 R4 HIGH-H 13 同款 PendingTab 路由错位,只是 cancellation 出口而非初始 emit 出口)
- [ ] (R4 reviewer-claude verify 已点名 codex 端 thread-loop:217 已在 S4 line 286-287 覆盖,无需重复)

##### S5 — createSession return handle.sessionId 用 applicationSid (**R3 HIGH-F jsdoc 等价性注明**)

- [ ] 修改 `src/main/adapters/claude-code/sdk-bridge/index.ts:367` (createSession 主入口收尾):
  - 当前: `return { sessionId: realId, abort: () => void this.interrupt(realId) };`
  - 改为: `return { sessionId: internal.applicationSid, abort: () => void this.interrupt(internal.applicationSid) };`
  - **R3 HIGH-F jsdoc 必注明**: spawn 主路径下 applicationSid 已在 S3 first realId 到达时切到 realId,与现有 `return { sessionId: realId }` 字面行为等价 — caller 拿到的就是 first realId;resume / fallback 路径下 applicationSid = caller 传入 opts.resume 全程不变
- [ ] 修改 `src/main/adapters/codex-cli/sdk-bridge/index.ts:636` (resume 路径) + `:645,663` (新建路径) 同款 `return { sessionId: internal.applicationSid }`

##### S6 — fork detect 比较改成 cli sid 对 cli sid (**R6 HIGH-R6-1 修订**: 用 effectiveResumeCliSid 不再 short-circuit)

- [ ] 修改 `src/main/adapters/claude-code/sdk-bridge/stream-processor.ts:305-313`:
  - 当前: `if (resumeId && resumeId !== realId) { sessionManager.renameSdkSession(resumeId, realId); }` — `resumeId` 是 applicationSid,`realId` 是 cliSid,反向 rename 后 `applicationSid !== cliSid` 必触发误判
  - 改为: `if (effectiveResumeCliSid && effectiveResumeCliSid !== realId) { sessionManager.updateCliSessionId(internal.applicationSid, realId); }` — 比较 effective cli sid 对 realId (真实 fork 才命中);触发后 update applicationSid 行的 cli_session_id 列(不动 sessions.id)
  - **R6 HIGH-R6-1 修订**: 比较用 `effectiveResumeCliSid`(S1 R6 升级,bridge 内部反查兜底回填)而非 `opts.resumeCliSid` — 防止 caller 不传 resumeCliSid 时 condition short-circuit 让 fork detect 完全跳过
  - `consume()` 函数签名加 `effectiveResumeCliSid?: string` 参数(**R8 LOW-R8-2 修订**: 命名用 `effectiveResumeCliSid` 而非 `resumeCliSid`,明示 caller 已 resolve bridge 内部 effective 值不再是 opts.resumeCliSid 原始 caller 入参 — 防 future maintainer 误用直接读 opts.resumeCliSid 又撞 short-circuit);caller `waitForRealSessionId(... , effectiveResumeCliSid)` 同步改
- [ ] 修改 `src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts:249-275` case 3:
  - 当前比较 `internal.threadId !== ev.thread_id` 已是 cli sid 维度(语义对) — 字面无需改
  - 但 L263 `sessionManager.renameSdkSession(oldId, newId)` → `sessionManager.updateCliSessionId(internal.applicationSid, newId)` 改 update 目标
  - L259-260 sessions Map mutate 已 S3 改: case 3 反向 rename 后 sessions Map key 已是 applicationSid (spawn 主路径 S3 改造结果),case 3 fork 不再 mutate sessions Map — 整段简化为只 update `internal.threadId = ev.thread_id`,**原 L259-260 delete oldId / set newId 整段删**

##### S6.5 — recoverer / restart-controller caller 显式传 resumeCliSid (**R6 HIGH-R6-1 双方共识必修**: caller side 防御)

**R6 HIGH-R6-1 双方共识必修**: reviewer-claude R6 grep 实证 recoverer.ts:486 + codex/recoverer.ts:359 现状 caller 不显式传 resumeCliSid。虽然 S1 R6 升级 effectiveResumeCliSid 已在 bridge 内部兜底回填 — 但 caller 显式传保持显式契约 + 避免 future bridge 升级时漏 effective 计算 + 与 R3 MED-R3-2 restart-controller 修法 pattern 对齐(plan §Step C.1 line 533 已对显式传)。**两层防御协同**:bridge 内部 effective 兜底(S1+S6)+ caller 显式传(本 substep)。

- [ ] 修改 `src/main/adapters/claude-code/sdk-bridge/recoverer.ts:486` createThunk normal resume 调用:
  - 当前: `createThunk({ cwd: effectiveCwd, prompt: text, resume: sessionId, permissionMode: ..., ... })` (不传 resumeCliSid)
  - 改为: `createThunk({ cwd: effectiveCwd, prompt: text, resume: sessionId, resumeCliSid: rec.cliSessionId ?? sessionId, permissionMode: ..., ... })`
  - 注释明示: 同 R3 MED-R3-2 restart-controller 修法 pattern — caller 入参 opts.resume 是 applicationSid,显式传 resumeCliSid 让 SDK CLI `--resume` 拿正确 cli sid + S6 fork detect 不 short-circuit
- [ ] 修改 `src/main/adapters/codex-cli/sdk-bridge/recoverer.ts:359` 对称同款修法:
  - 当前: `createThunk({ cwd: effectiveCwd, prompt: text, resume: sessionId, codexSandbox: ..., ... })` (不传 resumeCliSid)
  - 改为: `createThunk({ cwd: effectiveCwd, prompt: text, resume: sessionId, resumeCliSid: rec.cliSessionId ?? sessionId, codexSandbox: ..., ... })`
- [ ] (Step C.1 restart-controller 同款修法 plan line 533 已对,无需重复)

##### S7 — MCP token caller sid 用 applicationSid

- [ ] 修改 `src/main/adapters/codex-cli/sdk-bridge/index.ts:392-393`:
  - 当前: `const initialSid = opts.resume ?? randomUUID(); const sessionToken = mcpSessionTokenMap.allocate(initialSid);`
  - 改为: `const sessionToken = mcpSessionTokenMap.allocate(internal.applicationSid);` — token map key = applicationSid (与 spike3 §3.7 实证语义对齐)
- [ ] 修改 `src/main/adapters/claude-code/sdk-bridge/mcp-server-init.ts:51-62`(若 token allocate 用过 realId 则同款修;实施时 grep 确认)

##### S8 — jsonl-missing fallback 不再走 createThunk 新建路径 (**R3 HIGH-G 升级**: 用 resumeMode 字段显式)

**R3 HIGH-G 升级**: 不再用 `resumeCliSid: undefined` 隐式触发 fresh CLI thread 语义(与 spawn 主路径 opts.resume 空入参侧无法区分),改用 S1 新增的 `resumeMode: 'fresh-cli-reuse-app'` 字段显式标记。

- [ ] 修改 `src/main/adapters/claude-code/sdk-bridge/recoverer.ts:428-477` jsonl-missing 分支:
  - **核心改写**: 不再走 `createThunk({...不传 resume...})` 创建 NEW realId sessions row,改为复用 applicationSid 行
  - 改为: `createThunk({ resume: applicationSid, resumeMode: 'fresh-cli-reuse-app', ... })` — 显式 mode 字段触发 bridge 内部「applicationSid 复用 + cli sid 新建」语义,SDK 不带 resume 自然给新 cliSid
  - bridge 内部识别 `resumeMode === 'fresh-cli-reuse-app'` 后:
    - SDK options 不传 `resume` 字段 (走 fresh CLI thread)
    - first realId 拿到时调 `sessionManager.updateCliSessionId(applicationSid, newRealId)` (**R5 HIGH-R5-1 / R6 MED-R6-1 修订**: 走 manager 内部 OLD_CLI 黑名单链;**不**直接调 sessionRepo.updateCliSessionId 绕开黑名单)
    - **不**调 finalizeSessionStart 创建新 sessions row,**不**emit session-start (避免 ingest 创建 NEW row 撞唯一索引)
    - sessions Map 已含 applicationSid entry (caller 传入 applicationSid = ctor 时已 set),不再 mutate
    - SDK claim / token map 全部仍用 applicationSid (S3-S7 已保证)
  - 返回 `applicationSid` (R1 fix line 234 `return sessionId` 字面已正确,此处仅语义澄清)
- [ ] 修改 `src/main/adapters/codex-cli/sdk-bridge/recoverer.ts:301-350` 对称同款改造

##### S9 — finalizeSessionStart 用 applicationSid (**R3 HIGH-F jsdoc spawn 主路径调用点**)

- [ ] 修改 `src/main/adapters/claude-code/sdk-bridge/session-finalize.ts:48-90` finalizeSessionStart 函数签名:
  - 入参 `realId: string` 改为 `applicationSid: string` + `cliSessionId?: string` 双入参(若入参 cliSessionId 非空则 update cli_session_id 列)
  - 内部 `emit({ sessionId: applicationSid, ... })` 派 session-start
  - 内部 `sessionRepo.setClaudeCodeSandbox(applicationSid, ...)` / `setModel(applicationSid, ...)` / `setExtraAllowWrite(applicationSid, ...)` 全用 applicationSid 持久化
  - **新增**: `sessionRepo.updateCliSessionId(applicationSid, cliSessionId)` 写 cli_session_id 列(若入参非空)— 替代 §A.2 ensure 默认 sessionId 行为(spawn 主路径 first realId 后通过此路径写正确 cliSid)
  - **R3 HIGH-F jsdoc 必注明**: spawn 主路径下 finalizeSessionStart **被调** 时 applicationSid 已切到 realId (S3 修订),`emit session-start { sessionId: applicationSid }` = `emit session-start { sessionId: realId }` 与现有 session-finalize.ts:48-90 行为等价;jsonl-missing fallback 路径**不**调 finalizeSessionStart (S8 已说) — 因为 sessions.id 没变不需要 emit session-start
- [ ] 修改调用点 `src/main/adapters/claude-code/sdk-bridge/index.ts:356` 同步改 `applicationSid: internal.applicationSid, cliSessionId: realId`(替换原 `realId` 入参 — spawn 主路径下 applicationSid === realId 因为 S3 已切,语义清晰)
- [ ] codex 端无 finalizeSessionStart 等价(codex 在 thread-loop case 1 内联做 setModel / setExtraAllowWrite 等,需对应改用 applicationSid)

##### S10 — sdk-bridge identity split 实施完整性自检 (**R4 HIGH-H 升级**: grep matrix 完备性 4 条 pattern)

**R4 HIGH-H 升级**: S10 grep matrix 必须覆盖现有代码所有 `realSessionId / threadId` 字段读位置,确保 R4 fix 后 0 命中 (除 S2 字段定义本身)。

- [ ] grep verify 全 codebase 不再有「sessions.id == cliSessionId 隐式假设」:
  - `grep -rE 'sessions\.set|sessions\.delete' src/main/adapters/` — sessions Map mutate 必 use applicationSid
  - `grep -rE 'event\.sessionId\s*=|sessionId:\s*realId|sessionId:\s*ev\.thread_id' src/main/adapters/` — event emit 必 use applicationSid
  - `grep -rE 'mcpSessionTokenMap\.allocate|mcpSessionTokenMap\.rename|mcpSessionTokenMap\.release' src/main/` — token map ops 必 use applicationSid
  - **R4 HIGH-H 加 4 条 pattern**:
    - `grep -rE '\.realSessionId\s*\?\?\s*tempKey' src/main/adapters/` → 0 命中(S2 字段 rename 后 + S4b 改造后)
    - `grep -rE '\.cliSessionId\s*\?\?\s*tempKey' src/main/adapters/` → 0 命中(S2 字段 rename 后字面变 cliSid 维度,新代码不能再用兜底 ?? tempKey)
    - `grep -rE '\.threadId\s*\?\?\s*key' src/main/adapters/codex-cli/` → 0 命中(codex 端同款修)
    - `grep -rE '(internal|rec|sess)\.(realSessionId|threadId|cliSessionId)\b' src/main/` — 列举所有读 cliSid/threadId 字段位置,逐处审计是否该改 applicationSid
- [ ] 类型守卫: TS strict 模式下 `applicationSid` 字段必非空,`cliSessionId` 字段允许 null(spawn tempKey 阶段 + jsonl-missing fallback 起 fresh CLI 期间)

##### S11 — 全 caller 矩阵审计 (**R6 HIGH-R6-1 reviewer-claude 建议**: caller side dependency 完备性)

**R6 反驳轮 reviewer-claude 建议**: R5 教训(跨 substep 时序竞态 + 文件级覆盖完备性)在 R6 再次命中 — 这次是「跨 caller dependency analysis」+「plan substep 与文件级 caller 覆盖完备性 cross-check」。**全 caller 矩阵审计**列入 plan,implementation-time 实测 grep + 逐 caller 显式核对。

**claude 端 createThunk / createSession caller 矩阵**:

| caller file:line | 路径类型 | resumeMode | 显式传 resumeCliSid? | 修订 |
|---|---|---|---|---|
| sdk-bridge/index.ts spawn 主路径(无 opts.resume)| spawn | 'resume-cli' default | undefined (spawn isNewSpawn 路径不需要) | 现状不变 |
| recoverer.ts:486 normal resume | resume | 'resume-cli' default | **R6 S6.5 加** `rec.cliSessionId ?? sessionId` | R6 修 |
| recoverer.ts:428 jsonl-missing fallback | fresh fallback | 'fresh-cli-reuse-app' | undefined (fresh 路径不需要) | 现状不变(R5 fix) |
| restart-controller.ts:185 restartWithPermissionMode | restart | 'resume-cli' | R3 MED-R3-2 修 `sessionRepo.get(currentSid)?.cliSessionId ?? currentSid` | R3 修 |
| restart-controller.ts:339 restartWithClaudeCodeSandbox | restart | 'resume-cli' | R3 MED-R3-2 修同款 | R3 修 |

**codex 端 createThunk / createSession caller 矩阵**:

| caller file:line | 路径类型 | resumeMode | 显式传 resumeCliSid? | 修订 |
|---|---|---|---|---|
| sdk-bridge/index.ts spawn 主路径 | spawn | 'resume-cli' default | undefined (spawn 不需要) | 现状不变 |
| recoverer.ts:359 normal resume | resume | 'resume-cli' default | **R6 S6.5 加** `rec.cliSessionId ?? sessionId` | R6 修 |
| recoverer.ts:301 jsonl-missing fallback | fresh fallback | 'fresh-cli-reuse-app' | undefined (fresh 路径不需要) | 现状不变(R5 fix) |
| restart-controller.ts createSession 调用 | restart | 'resume-cli' | R3 MED-R3-2 同款修 | R3 修 |

- [ ] **implementation-time 必跑 caller 矩阵 grep verify**:
  ```bash
  # claude 端
  grep -nE 'createThunk\(|createSession\(' src/main/adapters/claude-code/sdk-bridge/ | grep -v node_modules
  # codex 端
  grep -nE 'createThunk\(|createSession\(' src/main/adapters/codex-cli/sdk-bridge/ | grep -v node_modules
  ```
  逐 caller 核对:`resumeMode === 'resume-cli' && opts.resume` 时是否显式传 resumeCliSid 或显式说明为何不需要(spawn 主路径 / fresh fallback 路径)。如发现新 caller(future plan 加新调用点),必须按本矩阵 pattern 同款显式传或显式标注。
- [ ] 如 caller 矩阵表 future 加新条目,plan §A.4-pre S11 必同步更新(implementation-time 维护)

#### Step A.4 — 2 处 jsonl-missing fallback rename 反转(80% 价值核心,与 §A.4-pre S8 集成)

> **R2 MED-R2 升级**: 本节修法已在 §A.4-pre S8 子项详写完整。本节保留作语义入口锚点 — 实施时按 S8 substep 执行。

- [ ] 修改 `src/main/adapters/claude-code/sdk-bridge/recoverer.ts:466`(S8 已覆盖):
  - `sessionManager.renameSdkSession(sessionId, newRealId)` 路径作废 — R2 升级后 createThunk 内部直接走「applicationSid 复用 + cli sid 新建」语义,first realId 后通过 `sessionManager.updateCliSessionId(applicationSid, newRealId)` 写 cli_session_id 列(**R5 HIGH-R5-1 / R6 MED-R6-1 修订**: 走 manager 内部黑名单链,**不**调 finalizeSessionStart — 与 S8 不创建 NEW row + 不 emit session-start 契约对齐;**不**直接调 sessionRepo.updateCliSessionId 绕开黑名单)
  - 不再触发 sessions.id 改变,application sid 仍是入参 sessionId
  - 返回值: `return sessionId`(application sid 稳定)
- [ ] 修改 `src/main/adapters/codex-cli/sdk-bridge/recoverer.ts:339`:同款修法
- [ ] 修改 `src/main/session/manager.ts` 新增 `updateCliSessionId(sid, newCliSid)` 公开 API,内部:
  - `const oldCliSid = sessionRepo.get(sid)?.cliSessionId ?? sid` (rec 兜底用 sid)
  - 调 `sessionRepo.updateCliSessionId(sid, newCliSid)` (单列 UPDATE)
  - 调 `recentlyDeleted.set(oldCliSid, Date.now())` 加 OLD_CLI_ID 进黑名单(防迟到 hook event 携带 OLD_CLI_ID 复活幽灵 record)
  - **不**触发 session-renamed event(sessions.id 没变,renderer listener 不需要)
  - **不**调 mcpSessionTokenMap.rename(token map 用 sessions.id 做 key,反向 rename 不动 sessions.id → token 永远稳定)

#### Step A.5 — 验证 + commit (Step A 收口)

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm build` 通过
- [ ] 跑现有 vitest test: `recoverer.test.ts` / `manager.test.ts` / `agent-deck-repos.test.ts` 全套绿(改 mock 名: `renameSdkSession` → `updateCliSessionId` 单点)
- [ ] **R1 MED-D + R2 MED-R2-2 必加显式不变量回归 test**(每条不变量对应 1 个 test case + R2 新增 test 6/7):
  - test 1: DB row `{id:'app-old', cliSessionId:'cli-new'}` → sendMessage('app-old', 'hello') 走 recovery → SDK options.resume == 'cli-new' / jsonl preflight stat path `<encoded-cwd>/cli-new.jsonl`(CLI 入参用 cli_session_id)
  - test 2: 同上 mock → events.sessionId == 'app-old' / sessions Map key == 'app-old' / wire prefix [sid app-old](应用层不变)
  - test 3: 反向 rename 路径 `updateCliSessionId('app-old', 'cli-new')` → sessionRepo.get('app-old').cliSessionId === 'cli-new' / sessions.id 不变 / OLD_CLI_ID 进 recentlyDeleted 黑名单 / **不**emit session-renamed
  - test 4: 迟到 hook event sessionId='cli-old' → ingest 入口 findByCliSessionId('cli-old') 找不到 + isRecentlyDeleted('cli-old') 命中 → drop(不复活 record)
  - test 5: 现役 hook event sessionId='cli-new' → ingest 入口 findByCliSessionId('cli-new') 命中 'app-old' → 覆写 event.sessionId='app-old' 走 dedupOrClaim → ensureRecord('app-old') 命中现役 row 不复活
  - **test 6 (R2 MED-R2-2 必加 + R7 MED-R7-2 修订增补黑名单回归断言)**: jsonl-missing fallback 路径 — DB row `{id:'app-old', cliSessionId:'cli-old', cwd:'/tmp'}`,jsonl `/tmp/cli-old.jsonl` 缺失,sendMessage('app-old', 'hello') → createThunk(applicationSid='app-old', resumeMode='fresh-cli-reuse-app') 走 fresh CLI thread,SDK 返 'cli-fresh' → **断言**:DB 仅 1 row id='app-old' cliSessionId='cli-fresh' / 无 row id='cli-fresh' / sessions Map key='app-old' / handle return.sessionId='app-old' / token map key='app-old' / **R7 MED-R7-2 加** `sessionManager.updateCliSessionId('app-old', 'cli-fresh')` 被调用 (manager 黑名单链 verify,不直接 sessionRepo.updateCliSessionId 绕过) / **R7 MED-R7-2 加** `recentlyDeleted.has('cli-old') === true` (60s 黑名单生效;manager 内部读 oldCliSid='cli-old' 进黑名单) / **R7 MED-R7-2 加** 迟到 hook event sid='cli-old' → ingest 3b 命中黑名单 drop (与 test 4/15/17 路径对称)
  - **test 7 (R2 MED-R2-2 必加 + R5 HIGH-R5-1 修订)**: jsonl-exists normal resume `appSid != cliSid` — DB row `{id:'app', cliSessionId:'cli'}` + jsonl `<encoded-cwd>/cli.jsonl` 存在,sendMessage('app', 'hello') → createThunk(applicationSid='app', resumeCliSid='cli') 走 SDK resume → first SDK frame realId='cli' → **断言**:
    - 不触发 fork detect (`resumeCliSid === realId`)
    - **R5 HIGH-R5-1 修订**: 不调 sessionRepo.updateCliSessionId (S3 else 'resume-cli' 路径不再直接写 DB)
    - 不调 sessionManager.updateCliSessionId (S6 fork detect 不触发)
    - events.sessionId='app' / sessions Map key='app' / 无 sessions row id='cli'
  - **test 8 (R3 MED-R3-3 必加)**: 3c ingest 现状逻辑保留 — pendingSdkCwds 含 '/tmp',hook event sessionId='cli-new' cwd='/tmp',findByCliSessionId('cli-new') miss + 不在黑名单 + cwd 命中 → 走原 dedupOrClaim 时序兜底 claim+skip(不复活 record;REVIEW_5 H1 / REVIEW_12 修法保留)
  - **test 9 (R3 MED-R3-3 必加)**: 3d ingest 现状逻辑保留 — hook event sessionId='cli-new' cwd='/tmp',findByCliSessionId('cli-new') miss + 不在黑名单 + cwd 不命中 pendingSdkCwds → 走原 ensureRecord 建外部 CLI 会话(现状 fallback 不变)
  - **test 10 (R3 HIGH-F 必加)**: spawn bootstrap 不变量 (R3 HIGH-F applicationSid 生命周期分两阶段 spawn 路径 verify) — brand-new spawn 后 ① DB row id == first realId(applicationSid 已切到 realId, S3 修订)② cli_session_id 列 == first realId(S9 写入)③ session-renamed{from: tempKey, to: first realId} 事件 emit(D6 契约)④ renderer store.renameSession 行为正常(selectedId / by-session state 迁移)
  - **test 11 (R3 HIGH-F 必加)**: resume 路径 applicationSid 不变 (R3 HIGH-F applicationSid 生命周期分两阶段 resume 路径 verify) — caller 传 opts.resume = applicationSid 起 createSession,sessions.id 全程 == applicationSid;cli_session_id 列若 fork detect 触发可变化;session-renamed 不 emit
  - **test 12 (R4 HIGH-H 必加)**: team-task-* mcp 流 — jsonl-missing fallback 后 (DB row `id='app', cliSid='cli-fresh'`),teammate 调 mcp__tasks__task_create → AgentEvent.sessionId === 'app' / agentDeckTeamRepo.findActiveMembershipsBySession('app') 命中 (不撞 cli-fresh miss)
  - **test 13 (R4 HIGH-H 必加)**: permission UI 流 — fallback 后 SDK invoke canUseTool → emit waiting-for-user event.sessionId === 'app' / renderer SessionDetail('app') 渲染 PendingTab 不漂浮
  - **test 14 (R4 HIGH-H 必加)**: user-message stream 流 — fallback 后 sendMessage('app', 'hello') → createUserMessageStream `sessions.has('app')` 命中 (不撞 cli-fresh miss) → 流式不断流,SDK 真收到 prompt 输出 (用户报告 bug 触发场景之一 verify 修法)
  - **test 15 (R5 HIGH-R5-1 必加)**: normal resume 真实 fork OLD_CLI 黑名单回归 — DB row `{id:'app', cliSessionId:'OLD_CLI'}` + jsonl 存在,sendMessage('app', 'hello') 走 SDK resume → first realId='NEW_CLI'(真实 fork) → **断言**:
    - S3 else 'resume-cli' 路径**不**直接调 sessionRepo.updateCliSessionId (R5 HIGH-R5-1 修订)
    - S6 fork detect 触发 sessionManager.updateCliSessionId('app', 'NEW_CLI') (走 manager 黑名单包装)
    - manager.updateCliSessionId 内部读 oldCliSid='OLD_CLI'(S3 没抢先写 DB,read 拿到正确 OLD)
    - sessionRepo.get('app').cliSessionId === 'NEW_CLI' (manager 内部写)
    - **recentlyDeleted.has('OLD_CLI') === true** (黑名单链不断)
    - 迟到 hook event sid='OLD_CLI' → ingest 3b 命中黑名单 drop (不复活幽灵 record)
  - **test 16 (R5 MED-R5-1 必加)**: appSid != cliSid 场景 close cancellation 路由 — DB row `{id:'app', cliSessionId:'cli'}`,先调 SDK invoke canUseTool 触发 emit `permission-prompt` event.sessionId === 'app' (S4b L4 修法,can-use-tool.ts:139 走 getSessionId() = applicationSid),PendingTab(app) 显示 pending 项;之后 closeSession('app') → pending-cancellation.ts:95 → cancelPendingAndEmit emit `permission-cancelled` event.sessionId === **'app'** (R5 MED-R5-1 修法 realIdForEmit = internal.applicationSid) → renderer SessionDetail('app') 收到 cancellation 路由清掉 PendingTab(app) pending 项
  - **test 17 (R6 HIGH-R6-1 必加)**: recoverer.ts:486 normal resume 真实 fork OLD_CLI 黑名单回归 — sessions Map 内 sid='app1' dormant + DB row `{id:'app1', cliSessionId:'cli_old'}` + jsonl 在,recoverAndSend('app1', 'msg') → createThunk 真实 fork(first realId='cli_new') → **断言**:
    - opts.resumeCliSid === 'cli_old' (R6 S6.5 修法:caller 显式传 from rec.cliSessionId)
    - effectiveResumeCliSid === 'cli_old' (S1 R6 升级:caller 已显式传,直接用)
    - S6 fork detect 触发(`effectiveResumeCliSid !== realId`)→ `sessionManager.updateCliSessionId('app1', 'cli_new')` 调 1 次
    - **recentlyDeleted.has('cli_old') === true** (60s 黑名单生效;manager 内部读 oldCliSid='cli_old' 进黑名单)
    - sessions.get('app1').cliSessionId === 'cli_new' (DB)
    - applicationSid 不变(events / file_changes 子表不迁)
    - 迟到 hook event sid='cli_old' → ingest 3b 命中黑名单 drop(不复活幽灵 record)
- [ ] **R1 MED-H 验证 (renderer 3 处 listener)**: 用户手实验 spawn 新 session(应该看到 tempKey → realId swap 不影响 UI),确认 3 处 renderer listener (App.tsx:130 / HistoryPanel.tsx:95 / use-event-bridge.ts:35) 现存行为兼容反向 rename 修法(实际上 spawn 路径 emit 行为不变,反向 rename 路径不 emit,3 处 listener 完全不触发)
- [ ] 用户手实验:启动应用后给历史会话发新消息,observe sessions.id 不变 + UI 不闪 + reviewer teammate 不撞 not found + send_message 不撞 cli_session_id 变化
- [ ] 写 CHANGELOG_X 引用归档(plan 完成后写)
- [ ] commit Step A 收口

### Step B — 2 处 fork detect rename 反转(claude streaming + codex case 3)

#### Step B.1 — claude stream-processor:313 fork detect 反转 (**R3 MED-R3-1 修订**: applicationSid 入参对齐 S6;**R8 LOW-R8-3 修订**: 实际改在 sub-commit A-4,本 Step B 是独立 commit boundary **仅 verify** 不重复修改)

> **R8 LOW-R8-3 cross-reference 明示**: §A.4-pre S6 (line 396-404) 与 Step B.1 (本节) 描述同一处代码 (stream-processor.ts:305-313 fork detect 反转)。R3 MED-R3-4 + R4 MED sub-commit 划分把 fork detect 改造划入 **sub-commit A-4** atomic patch (§A.4-pre S6 落地点);**Step B 整体作为独立 commit boundary 仅 verify** A-4 已落 + 跑 fork test 不再二次改 stream-processor (git 会拒重复 hunk + typecheck 会撞)。Step B.1 substep 描述保持完整作 implementation-time reference,实施时按 sub-commit A-4 一次性 atomic 修法。

- [ ] 修改 `src/main/adapters/claude-code/sdk-bridge/stream-processor.ts:305-313`:
  - 现有 `if (resumeId && resumeId !== realId) { sessionManager.renameSdkSession(resumeId, realId) }` 改为 `if (effectiveResumeCliSid && effectiveResumeCliSid !== realId) { sessionManager.updateCliSessionId(internal.applicationSid, realId) }` (与 §A.4-pre S6 一致)
  - **R3 MED-R3-1 修订**: update 第一参数必须是 `internal.applicationSid` (app sid 维度)而非 `resumeId` 局部变量 — 保证 UPDATE 命中正确 row
  - **R7 MED-R7-1 修订**: condition 用 `effectiveResumeCliSid` (与 S6 line 396 对齐) 不再 short-circuit;`waitForRealSessionId(... , effectiveResumeCliSid)` 同步改 — caller 不显式传 resumeCliSid 时 bridge 内部反查兜底回填
  - sessions Map key 仍是 applicationSid (S3 已切),不再 delete + set
- [ ] 修改 `src/main/adapters/claude-code/__tests__/sdk-bridge.consume-fork.test.ts`:
  - L100 assertion `expect(sessionManager.renameSdkSession).toHaveBeenCalledWith(OLD_ID, NEW_ID)` 改为 `expect(sessionManager.updateCliSessionId).toHaveBeenCalledWith(applicationSid, NEW_ID)` — first arg 必须是 app sid 不是 OLD cli sid
  - L139-141 fork 分支 not called 断言同步改名
  - **R7 MED-R7-1 加断言**: caller 不显式传 `resumeCliSid` (省略),bridge 内部 effective 反查命中 — 验证 fork detect 仍触发(case: caller passes opts.resume only, opts.resumeCliSid undefined, sessionRepo.get(resume).cliSessionId === 'OLD_CLI', SDK first realId === 'NEW_CLI' → S6 effectiveResumeCliSid='OLD_CLI' && !== 'NEW_CLI' 触发 → updateCliSessionId(applicationSid, 'NEW_CLI'))
- [ ] tempKey rename 路径 (stream-processor.ts:279) **保持不变**(spawn 主路径首次确认 sessions.id, S3 已修订 spawn 路径 internal.applicationSid 切到 first realId)

#### Step B.2 — codex thread-loop:263 case 3 post-resume fork 反转 (**R3 MED-R3-1 修订**: applicationSid 入参对齐 S6)

- [ ] 修改 `src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts:259-263`:
  - 现有 `sessionManager.renameSdkSession(oldId, newId)` 改为 `sessionManager.updateCliSessionId(internal.applicationSid, newId)` (与 §A.4-pre S6 一致)
  - **R3 MED-R3-1 修订**: update 第一参数必须是 `internal.applicationSid` 而非 `oldId` 局部变量(case 3 上下文中是 cli sid 维度)
  - L259-260 sessions Map mutate 已 §A.4-pre S6 删除 (case 3 不再 mutate sessions Map,只 update internal.threadId)
- [ ] 修改 `src/main/adapters/codex-cli/__tests__/sdk-bridge.consume-fork.test.ts` 同款断言改 first arg = applicationSid
- [ ] tempKey 路径 (thread-loop.ts:154) **保持不变**(spawn 主路径首次确认 sessions.id, S3 已修订)

#### Step B.3 — 验证 + commit (Step B 收口)

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm build` 通过
- [ ] vitest fork detect test 绿
- [ ] **R1 MED-D 加显式不变量回归 test**(fork detect 路径):
  - test: streaming + resume + 新 prompt 触发 CLI 隐式 fork → `updateCliSessionId(internal.applicationSid, realId)` (R3 MED-R3-1 修订:第一参数 app sid 维度) → sessions.id 不变 + cli_session_id 更新 + sessions Map key 不变
- [ ] 用户手实验:streaming + resume + 新 prompt 触发 CLI 隐式 fork 场景下 sessions.id 不变
- [ ] commit Step B 收口

### Step C — 2 处 restart-controller fork rename 反转(claude restartWith*)

#### Step C.1 — claude restart-controller:189 + restart-controller:341 反转 (**R3 MED-R3-2 修订**: 显式 createSession 入参拆同 §A.4-pre S1)

- [ ] 修改 `src/main/adapters/claude-code/sdk-bridge/restart-controller.ts:185-198`:
  - 现有 `sessionManager.renameSdkSession(currentSid, newRealId)` 改为 `sessionManager.updateCliSessionId(currentSid, newRealId)` (currentSid 在 restart-controller 上下文是 applicationSid 入参,与 Step B 不同)
  - 返回值 `return newRealId` 改为 `return currentSid`(application sid 稳定)
  - **R3 MED-R3-2 修订**: 同步修改 createSession 调用入参 — 现 `createSession({ resume: currentSid, ... })` 改为 `createSession({ resume: currentSid, resumeCliSid: sessionRepo.get(currentSid)?.cliSessionId ?? currentSid, ... })` (同 §A.4-pre S1 入参拆 — caller 入参 opts.resume 是 applicationSid,显式传 resumeCliSid 让 SDK CLI `--resume` 拿正确 cli sid;反向 rename 后 currentSid != cliSessionId 才有效,否则两者相等行为与现状字面等价)
- [ ] 修改 `src/main/adapters/claude-code/sdk-bridge/restart-controller.ts:339-349` 同款修法 (restartWithClaudeCodeSandbox 内 fork detect):
  - rename → updateCliSessionId 同款
  - **R3 MED-R3-2 修订**: createSession 同款入参拆
- [ ] 修改 `src/main/adapters/claude-code/sdk-bridge/__tests__/restart-controller-fork-rename.test.ts`:
  - rename event listener (`session-renamed`) 改为不监听(因为反向 rename 不 emit 此 event)
  - assertion 从「Map entry 从 OLD → NEW transfer」改为「Map entry key 不变 = currentSid」
  - **R1 MED-D 加显式不变量 test**:`updateCliSessionId(currentSid, newRealId)` 后 sessions.id 不变 + cli_session_id 更新 + 不 emit session-renamed
  - **R3 MED-R3-2 加 test**: `createSession` 入参 `resume: applicationSid` + `resumeCliSid: cliSessionId` 双轨断言

#### Step C.2 — codex restart-controller 已无真实 rename 调用,跳过

- [ ] verify codex `restart-controller.ts:134-141` 内 (REVIEW_40 R2 reviewer-codex P3 LOW 已删 post-rename block 仅注释 ref 留,不需修改本 file)
- [ ] **R3 MED-R3-2 修订**: codex restart-controller 仍有 `createSession({resume: sessionId, ...})` 入参,需 §A.4-pre S1 同款入参拆 — `createSession({ resume: sessionId, resumeCliSid: sessionRepo.get(sessionId)?.cliSessionId ?? sessionId, ... })`(claude 端 restart-controller 同款理由,反向 rename 后 SDK CLI `--resume` 字段需用 cli sid)

#### Step C.3 — 验证 + commit (Step C 收口)

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm build` 通过
- [ ] vitest restart-controller-fork-rename test 改完后绿
- [ ] 用户手实验:从 acceptEdits 切到 bypassPermissions 触发 cold restart,sessions.id 不变 + 用户已选 mode 复原
- [ ] commit Step C 收口

### Step 4 收口

- [ ] `archive_plan` tool 调用 (mcp__agent-deck__archive_plan)
- [ ] CHANGELOG_X 引用归档(不抄全 plan)

## 当前进度

- ✅ Step 0 RFC 2 轮对齐完毕（D1-D8 全套设计决策定稿）
- ✅ plan-dir + spike-reports/ 子目录已建
- ✅ Step 0.5 Spike 4 个全跑完(spike1-4)
- ✅ 回写 plan §设计决策 D1-D8 *待 spike 验证* → *已 spike: ...* 标注全部完成
- ✅ 拆 Step A/B/C substep checklist 精确到 file:line
- ✅ Step 1.5 Deep-Review R1 完成: 3 HIGH + 6 MED 已应用修订
- ✅ Step 1.5 Deep-Review R2 完成: §A.4-pre 升级为「bridge identity split」9+1 substep S1-S10
- ✅ Step 1.5 Deep-Review R3 完成 + R3 fix 应用: HIGH-F applicationSid 双阶段化 + HIGH-G resumeMode 字段
- ✅ **Step 1.5 Deep-Review R4 完成**: 双方共识 HIGH-R4-1 (S3 字面 isNewSpawn 分支保护) + HIGH-H (applicationSid 贯穿覆盖扩展 5+ 处 provider/getter/map access) + 双方共识 MED (sub-commit A-3/A-5 依赖图调整) + MED-R4-1 (S1 7 种组合不变量表 + runtime guard);两份反驳轮均自承漏列 + 完全支持
- ✅ **R4 fix 应用到 plan**: S3 字面 isNewSpawn 分支保护伪代码(claude + codex 对称) + 新增 S4b applicationSid 贯穿 5+ 处改造(mcp-server-init / index.ts canUseTool / createUserMessageStream) + 扩 S10 grep matrix 4 条 pattern + S1 7 种组合不变量表 + sub-commit A-3 含 S9 atomic patch + 加 test 12/13/14 (HIGH-H e2e 验证)
- ✅ **Step 1.5 Deep-Review R5 完成**: 双方共识 HIGH-R5-1 (S3 与 S6 时序漏洞 — R4 fix 引入 — first-id mutation block 抢先写 NEW_CLI 覆盖 OLD_CLI → S6 fork detect 调 sessionManager 时 oldCliSid 反查拿到 NEW_CLI → 黑名单链断 → 迟到 hook event 复活幽灵 record);双方共识 MED-R5-1 (pending-cancellation.ts:95 S4b 5+ 处覆盖漏点 — close cleanup cancellation event 用 cliSid 维度让 PendingTab(appSid) pending 项无人清);R5 反驳轮 reviewer-claude 第 3 次自纪错完全支持 reviewer-codex
- ✅ **R5 fix 应用到 plan**: S3 else 分支拆细 (claude + codex 对称) — normal resume 不直接 sessionRepo.updateCliSessionId 写 DB,DB 写统一走 sessionManager 黑名单链;S4b 加第 6 项 pending-cancellation.ts:95 改造 + test 7 assertion 修订 + 加 test 15 (HIGH-R5-1 真实 fork OLD_CLI 黑名单回归) + test 16 (MED-R5-1 cancellation 路由回归)
- ✅ **Step 1.5 Deep-Review R6 完成**: 双方独立同款 HIGH-R6-1 (normal resume `resumeCliSid` 缺失让 S6 fork detect 失效 — recoverer.ts:486 + codex/recoverer.ts:359 caller 不显式传 resumeCliSid + S6 condition `if (opts.resumeCliSid && ...)` undefined 短路) — reviewer-codex 从 S1/S6 文案矛盾切入,reviewer-claude 从 recoverer.ts:486 现场 Read 切入,**两种修法互补**(bridge 内部 effective + caller 显式传);+ reviewer-codex 单方 MED-R6-1 (S8/A.4 stale 文案与 R5 黑名单链字面冲突)
- ✅ **R6 fix 应用到 plan**: S1 加 effectiveResumeCliSid 兜底规则 + S6 condition 用 effectiveResumeCliSid 不再 short-circuit + 新增 S6.5 (recoverer caller 显式传 resumeCliSid claude + codex 对称) + S8/A.4 stale 文案修订(改 sessionManager.updateCliSessionId 走黑名单链 + 删 finalizeSessionStart 提及与 S8 不 emit session-start 契约对齐)+ 新增 S11 全 caller 矩阵审计 + 加 test 17 (HIGH-R6-1 e2e) + sub-commit A-5 文案 test 范围扩到 10-17
- ✅ **Step 1.5 Deep-Review R7 完成**: reviewer-codex 1 HIGH (S1 effective resolver 未 guard opts.resume 字面 spawn 路径撞 sessionRepo.get(undefined)) + 2 MED (Step B.1 stale + test 6 黑名单断言不对称) vs reviewer-claude 0 HIGH + 1 MED 「可合 with caveat」(双方共识 MED-R7-2 test 6);lead 现场实证 reviewer-codex 单方 HIGH-R7-1 + MED-R7-1 均为真问题 + reviewer-claude R7 收敛信号判 「7 轮已逼近稳定状态」
- ✅ **R7 fix 应用到 plan**: HIGH-R7-1 (S1 effective resolver 三分支 guard opts.resume — !opts.resume → undefined 为 spawn 主路径) + MED-R7-1 (Step B.1 line 562 同步 effectiveResumeCliSid 与 S6 line 396 对齐 + waitForRealSessionId 同步 + fork test 加 effective 反查命中断言) + MED-R7-2 (test 6 加 OLD_CLI 黑名单断言对称 test 15/17)
- ✅ **Step 1.5 Deep-Review R8 final round 真共识收口达成**: 双方 0 HIGH + 0 MED + 「可合」共识;reviewer-codex R8 完整 verify R7 三项修复 + 残留旧写法 grep 0 命中;reviewer-claude R8 完整 verify 4 维度 + 抓 3 LOW non-blocking implementation-time tweak (LOW-R8-1 S1+assertCreateOptsValid 顺序 / LOW-R8-2 consume() 参数命名 / LOW-R8-3 S6 vs Step B.1 cross-reference);8 轮异构对偶 review 累计 ~40+ 项 fix 全部应用
- ✅ **3 LOW non-blocking fix 应用到 plan**: LOW-R8-1 + LOW-R8-2 + LOW-R8-3 字面修订完成
- ✅ **Step 2 EnterWorktree 完成**: worktree-reverse-rename-sid-stability-20260520 branch 已建 + cwd 切到 worktree
- ✅ **Step A 全 6 sub-commit 完成** (`579f934`-`9225d59`):A-1 schema migration v021 + sessionRepo helper / A-2 ingest 4 态分流 + 黑名单双写 / A-3 bridge identity split S1+S2+S3+S4+S4b atomic / A-4 S5+S6+S6.5+S8+S9 atomic / A-5 测试矩阵收口 + S3 ctor sessions Map key 修正 (resume 路径 sessions Map key 修正,createUserMessageStream 不再 miss)
- ✅ **Step B verify-only 完成**: fork detect 改造已含在 sub-commit A-4 atomic patch (R8 LOW-R8-3 cross-reference 明示);Step B 整体作独立 commit boundary 仅 verify
- ✅ **Step C restart-controller 反转完成** (`a33b9b6`): claude restartWithPermissionMode + restartWithClaudeCodeSandbox + codex restartWithCodexSandbox 三方法对称;RestartCreateOpts 加 resumeCliSid 字段 (R3 MED-R3-2 双轨入参);新增 3 test (resume + resumeCliSid 双轨断言 + cliSessionId === null 兜底)
- ✅ **CHANGELOG_136 + INDEX.md 引用归档完成** (`5c1986c`)
- ✅ **typecheck + build + 811 test pass + 83 skip 0 fail 全过**
- ⏳ **Step 4 archive_plan tool 调用** (本会话最后一步)

## 下一会话第一步

⚠️ **Step 0.5 Spike 已完成,plan §设计决策 + §步骤 checklist 已定稿**。下一阶段(本会话 user 确认是否启动):

1. **Step 1.5 Deep-Review (kind=plan)**:把本 plan 走多轮异构对抗 review (reviewer-claude + reviewer-codex teammate),挖 design 缺陷 / 不变量漏洞 / 流程矛盾,直到 reviewer 共识可合
   - 调用方式: `/agent-deck:deep-review` SKILL,args `{kind:'plan', paths:['/Users/apple/Repository/personal/agent-deck/.claude/plans/reverse-rename-sid-stability-20260520.md']}`
   - 出 HIGH finding 必修 / MED 现场验证 → 修订 plan → 用户 confirm 通过
2. **Step 2 EnterWorktree**(user 显式 confirm 后):
   - Bash `git -C /Users/apple/Repository/personal/agent-deck worktree add -b worktree-reverse-rename-sid-stability-20260520 /Users/apple/Repository/personal/agent-deck/.claude/worktrees/reverse-rename-sid-stability-20260520`
   - `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/reverse-rename-sid-stability-20260520")` (path 不是 name,避 v2.1.112 stale base bug)
3. **Step A → Step B → Step C** 按 §步骤 checklist 拆好的 substep 实施(每 Step 收口前跑 pnpm typecheck + build + vitest + 用户手实验)
4. **Step 4 收口**: `archive_plan` mcp tool 调用 + CHANGELOG_X 引用归档

**spike 阶段产物**(本会话产物,完成 plan 时 archive_plan 自动归档到 `<main-repo>/plans/<plan-id>/spike-reports/`):
- `spike-reports/spike1-cli-session-id-resume.md` + `spike1-runner.mjs` + `spike1.log`
- `spike-reports/spike2-fork-detect-trigger.md` + `spike2-runner.mjs` + `spike2.log`
- `spike-reports/spike3-wire-prefix-sid.md` + `spike3-runner.mjs` + `spike3.log`
- `spike-reports/spike4-late-hook-event.md` + `spike4-runner.mjs` + `spike4.log`

## 已知踩坑（spike 阶段持续追加）

- **CLAUDE.md「会话恢复 / 断连 UX」节双 fork 边界**：CLI 在 SDK streaming input + resume + 新 prompt 下行为不可控（软 fork：jsonl 在但给新 sid；hard fail：jsonl 不在抛 No conversation found）。spike1+2 必须双场景实测
- **EnterWorktree CLI v2.1.112 stale base bug**：本 plan Step 2 实施时必须走 `git worktree add -b <branch> <path>` + `EnterWorktree(path:)` 两步形式（详 user CLAUDE.md §Step 2 callout）
- **rename.ts 现有 plan linked-swimming-platypus 三段 UPDATE 已迁 team_members / spawn_link / messages**（rename.ts:115-152）—— 反向后 6 处更新仅 UPDATE cli_session_id 不再触发子表迁移（子表全量保留），实施时不要误删该三段
- **send_message no-shared-team check** 走 `agentDeckTeamRepo.findSharedActiveTeams` (member-query.ts:147-160)，过滤 `t.archived_at IS NULL AND sa.archived_at IS NULL AND sb.archived_at IS NULL`。反向后 sessions.id 不变 → team_member 行 session_id 不变 → 此查询自然 ✅
- **hook event sid → ingest 4 态分流路径**(R1 MED-E):反向 rename 后 hook event body.session_id = cli_session_id;ingest 入口 4 态分流(详 §A.3) — 实施者**必须**按 spike4 §4.7 实证完整覆盖 4 态(3a/3b/3c/3d),不能只写 3a/3b 漏 3c/3d 现状逻辑;dedupOrClaim 5 段顺序硬约束不破
- **renderer 3 处 listener (App.tsx:130 / HistoryPanel.tsx:95 / use-event-bridge.ts:35) 行为兼容**(R1 MED-H 验证 ✅):反向 rename 不 emit session-renamed,3 处 listener 路径完全不触发;spawn 主路径 tempKey rename 仍 emit + listener 行为不变 → renderer 体感 swap 仍 OK。Step A.5 加 1 substep typecheck + listener test 验证即可,**不需要改 listener 代码**
- **hand_off_session plan-driven mode 与 plan v2 spike 阶段契约不对齐**(R1 MED-G 改写):
  - frontmatter `worktree_path` 在 Step 2 EnterWorktree 之前是 **declarative placeholder**(让 future hand_off_session plan-driven mode 知道 worktree 应该建在哪),**当前 disk 上不存在**
  - 当前阶段(Step 0.5 → Step 1.5)接力必须走 generic mode:`hand_off_session({ prompt: ..., cwd: <main-repo-abs-path> })`,**不传 `plan_id`**(否则 plan-driven mode 会撞 worktree_path 不存在 reject)
  - Step 2 EnterWorktree 落 worktree 后才能用 plan-driven mode(`hand_off_session({ plan_id: ..., phase_label: ... })`)
  - **长期改进** (out of scope):考虑给 hand_off_session 加 `spike_mode` 跳过 worktree 检查,或调整 plan v2 让 spike artifacts 不依赖 worktree_path 字段
