# REVIEW_64 — PlantUML SSOT 失真度评审（17 图 × 4 主题）

## 触发场景

用户主动触发：项目近期经过 CHANGELOG_50–175 多轮拆分 / 重构 / 落地 universal-message-watcher / archive_plan / hand_off_session / sdk-bridge cwd resilience 等改造，怀疑 17 张架构图 / 流程图（plantUML SSOT）已与 src 实际实现脱节。

## 方法

- **类型**：mixed（plantUML SSOT 准确性 + src invariant 是否仍 enforce 双 mode 并行）
- **轮次**：R1（双 reviewer 完整全量 finding + lead 现场验证 + 三态裁决；HIGH/MED 都拿到铁证，未走 R2 反驳轮）
- **异构对抗对**：
  - reviewer-claude（claude-code adapter，Opus 4.7，sid `6532eaef-adb2-46ec-84fd-de12ea5f4cef`）
  - reviewer-codex（codex-cli adapter，gpt-5.5 xhigh，sid `019e72cf-ae33-7ee1-9361-b85597f57b5d`）
  - team：`puml-drift-review-20260529`（id `036c0d82-5fee-421c-9f45-0fb11cbdd515`）
- **scope**：17 .puml（8 architecture + 9 flow）+ 2 INDEX.md（architecture / flows）
- **对照 src baseline**：
  - archive-plan / hand-off / universal-message 图 baseline commit d5549c6
  - sdk-bridge 图 baseline commit 627a0c2 + 5b66cd8
  - agent-deck-mcp 顶层 baseline commit 7475b75 + d5549c6 + 8a41517

## Finding 总览

- reviewer-claude R1 出 18 条：HIGH 4 / MED 9 / LOW 3 / INFO 2
- reviewer-codex R1 出 13 条：HIGH 2 / MED 8 / LOW 3
- **合并去重后 23 unique findings**（双方独立提出的同根 finding 合并）
- **三态分布**：✅ 必修 17 / ❌ 反驳 1 / ❓ 待用户决策 5

## 三态裁决清单（按 4 主题 + INDEX 章节）

### A. archive-plan 主题（4 图）

整体一致度：**中等偏低** —— 主链路文件拆分、spike-reports 处理、INDEX smart update 基本画对；"7 步原子" 叙述与 4 子模块拆分后实际 step 数 / 失败语义严重失真。

#### A-✅-1 [HIGH] 4 图全 claim "原子 7 步收口" 与 src 实际 ≥ 14 step + post-ff-merge manual recovery 严重失真

- **图文件**：
  - `ref/architecture/archive-plan-architecture.puml:5,15,38,43,63`
  - `ref/flows/archive-plan-flow.puml:5,40`
  - `ref/flows/archive-plan-precheck-decision.puml:5,53`
  - `ref/architecture/archive-plan-state-machine.puml:5,69`
- **plantUML 原片段**（architecture.puml:43-50）：
  ```
  Impl --> Git : Step 1-2 checkout base_branch + ff-merge
  Impl --> Fs : Step 3-4 改 plan frontmatter + mv 到 ref/plans/
  Impl --> Fs : Step 4.5 mv spike-reports (有则迁,无则 skip)
  Impl --> Helpers : Step 5 INDEX smart update (4 列)
  Impl --> Git : Step 6 git add + commit
  Impl --> Repos : Step 7a 清 cwdReleaseMarker (commit 后提前清)
  Impl --> Git : Step 7b-c worktree remove + branch -D
  ```
- **src 实际状态**：facade 串联 `runPrecheck → runFfMerge → runArchiveFs → runCleanup`，每阶段 error 短路。各子模块 jsdoc step 编号：precheck 1/2/3/3.5a/3.5b/4/5/6/6.5+，ff-merge 7/8/8b/8c，archive-fs 9/10/11/12/12.5，cleanup 13/14。**实际 ≥ 14 step**。**且 post-ff-merge 失败语义不是「整体 abort 无部分回滚」而是 manual recovery**：`impl-archive-fs.ts:117-124` 明文 `Cannot retry archive_plan as a whole`，`impl-ff-merge.ts:93-108` 和 `impl-cleanup.ts:230-247` 走 `postFfMergeErr` 给手工 cleanup hint。
- **验证手段**：双方独立提出（reviewer-claude HIGH-1 + reviewer-codex MED-2 各从「步数」+「失败语义」两个角度同根命中）= 强冗余即算验证。
- **修正方案**（4 图统一改）：
  1. 图标题 / 注释「7 步原子」→「4 子模块原子收口（precheck + ff-merge + archive-fs + cleanup）」**不写具体数字**
  2. architecture.puml:43-50 把 Step 序号按子模块分组 `precheck Step 1-6.5` / `ff-merge Step 7-8c` / `archive-fs Step 9-12.5` / `cleanup Step 13-14`
  3. flow.puml + state-machine.puml 失败兜底节改：「precheck/ff-merge 前失败可 retry；post-ff-merge 失败进入 manual recovery 无自动 rollback」

#### A-✅-2 [MED] precheck 4 态 partition 与 src 实际 cwd × marker 8 分支决策树失真

- **图文件**：`ref/flows/archive-plan-precheck-decision.puml:22-37` + `ref/flows/archive-plan-flow.puml:30-37`
- **plantUML 原片段**：`4 态分流 (marker × cwd 在 worktree 内)` 只列 marker==worktreePath/null 与 cwd 在/不在 worktree 四格。
- **src 实际状态**：`src/main/agent-deck-mcp/tools/handlers/archive-plan/impl-precheck.ts:216-327` 实际 8 分支：cwd valid/invalid × marker null/matching/different + warn-not-release + cwd invalid + matching marker pass + cwd invalid + different marker reject。返回 `releaseMarkerOnSuccess` 字段图未 capture。
- **验证手段**：双方独立提出（codex MED-1 + claude MED-1 同根），强冗余。
- **修正方案**：
  1. partition 标题加 "(笛卡尔积 cwdValid × inWorktree × markerReal)"
  2. 4 态扩为 8 分支决策树，补 `marker 指其他 worktree warn 不释放` + `cwd invalid + matching marker pass` + `releaseMarkerOnSuccess` 字段

#### A-❓-1 [LOW → 降级] "fs/git 公共助手 10 个" 数字魔术常数

- **图文件**：`ref/architecture/archive-plan-architecture.puml:69-72`
- **plantUML 原片段**：`fs/git 公共助手 (10 个) 被 4 个 tool 共享`
- **src 实际状态**：未 grep 出明确 "10 个 helper" 集中定义文件，难校核。
- **验证手段**：单方提出无 src 现成 SSOT。
- **修正方案**：「10 个」→「若干」或加 "(详 INDEX 第 3 列 commit link)" 把数字 SSOT 推给 INDEX。**user 自己决定改不改**。

---

### B. hand-off-session 主题（4 图）

整体一致度：**中等偏高** —— handOffMode、cwd resilience、task policy 大方向画对；adopt-task 顺序倒置 + baton skipped 状态枚举不全 + facade 子模块拆分未画出。

#### B-✅-1 [HIGH] flow + architecture + state-machine 3 图 phase 1 跳过条件只列 2 状态，src 实际 6 状态完整枚举

- **图文件**：
  - `ref/flows/hand-off-session-flow.puml:78-82`
  - `ref/architecture/hand-off-session-architecture.puml:73-78`
  - `ref/flows/hand-off-session-decision.puml:81+`
  - `ref/architecture/hand-off-session-state-machine.puml:30-42`（entity 3 子态 3 个对应失真）
- **plantUML 原片段**（architecture.puml:73-78）：
  ```
  phase 1 跳过条件 (任一即跳):
  - adopt_teammates=true (teammate 已转给 newSid)
  - archive_caller=false (caller 保活,skipped='archive-caller-false-keep')
  ```
- **src 实际状态**：`src/main/agent-deck-mcp/tools/handlers/baton-cleanup.ts:166-174` + `shutdown-teammates-on-baton.ts:147,179` 完整 6 状态：
  - `null`（成功路径含 closed=[] 的 caller=lead 但 team 内无其他 active teammate）
  - `'adopt-keep-implicit'`（adopt_teammates=true，phase 4 引入）
  - `'archive-caller-false-keep'`（archive_caller=false，CHANGELOG_169 F4）
  - `'caller-not-lead'`（caller 不是 lead 含 external sentinel）
  - `'all-lead-teams-archived'`（caller 是 lead 但所有 team 已 archived，REVIEW_56 §F6 R2 修法）
  - `'phase-1-error'`（phase 1 内部 throw 兜底，REVIEW_56 §F6 Plan-Review Round 2 codex MED-3）
- **验证手段**：双方独立提出（claude HIGH-1 列 6 状态 + codex LOW-1 列 6 状态完全独立同款）= 强冗余 + lead 现场 Read `baton-cleanup.ts:166-234` 全文铁证。
- **修正方案**：
  1. 3 图（flow/decision/architecture）note 块全改为列完整 6 状态及 trigger 条件
  2. state-machine.puml entity 3（teammate sessions）把 3 子态扩 5 子态（Alive / Adopted / Closed / KeptByArchiveCallerFalse / KeptByCallerNotLead）让 transition 全部 render

#### B-✅-2 [MED] adopt + spawn + swapLead + task 顺序图与实现不一致

- **图文件**：
  - `ref/architecture/hand-off-session-architecture.puml:51-54`
  - `ref/flows/hand-off-session-flow.puml:46-66`
- **plantUML 原片段**：architecture.puml 把 `Handler --> Repos : 改 task ownership` 画在 `AdoptCtx` 与 `swapLead` 之前。
- **src 实际状态**：`handler-main.ts:178-306` 实际顺序 = prepare adopt snapshot → spawn → phase 1.5 `runPhase15AdoptSwapLeadLoop` → `runTaskReassignment`。`preserve-team` warning 依赖 `phase15Detail.adoptedTeamIds`。
- **验证手段**：双方独立提出（codex MED-3 + claude MED-1 同根角度互补），强冗余。
- **修正方案**：
  1. architecture.puml:51-54 调整为 `prepareAdoptSnapshotAndPrompt → spawn → phase1.5 swapLead → runTaskReassignment`
  2. AdoptCtx / swapLead 调用箭头加 `(pre-spawn)` / `(post-spawn)` 标签
  3. note 标注 `preserve-team` warning 使用 adopted team ids

#### B-✅-3 [MED] hand-off facade jsdoc 称 5 子模块，architecture 图未画拆分

- **图文件**：`ref/architecture/hand-off-session-architecture.puml:13-17`
- **plantUML 原片段**：L2 package 仅画 `[Handler]` `[Impl]` `[AdoptCtx]` 3 节点。
- **src 实际状态**：`src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts:1-37` jsdoc 明确列 6 子模块（facade / _deps / cwd-resolver / team-adopt-coordinator / task-reassign-coordinator / handler-main）。
- **验证手段**：单方 claude 提出 + lead 现场（claude 已 inject Read 上下文）确认。
- **修正方案**：L2 package 拆 4 子节点（facade / cwd-resolver / team-adopt-coordinator / task-reassign-coordinator），或加 note bottom of L2 列子模块名（轻量方案）。

#### B-❌-1 [HIGH 反驳 → 不修] state-machine entity 4 "30min grace 自动归档" — 实证图正确 src 仍 enforce

- **图文件**：`ref/architecture/hand-off-session-state-machine.puml:50-54`
- **claude reviewer 推理**：图 claim "team 无 lead 30min 后自动归档" 但 src 找不到 enforce → 标 *未验证* HIGH 候选请 lead 验证。
- **src 实际状态**：lead 现场 grep `teamArchiveGrace|leadlessTeam|TEAM_ARCHIVE_GRACE|graceMs` 命中 `src/main/teams/team-lifecycle-scheduler.ts:36,45,49,124` —— `if (now - latestClosedAt < this.graceMs) continue;` invariant 仍 enforce，test 多处 `graceMs: 30 * 60_000`。
- **验证手段**：lead 现场 Grep 实测铁证。
- **裁决**：❌ 反驳 reviewer-claude 的怀疑 —— 图正确 + src 也对，不修。

---

### C. sdk-bridge 主题（4 图）

整体一致度：**偏低** —— claude/codex 双端拆分主框架 OK；但 Codex jsonl 路径完全画错（与 cwd 无关而非 cwd-encoded）、fresh fallback 走 `fresh-cli-reuse-app` + `updateCliSessionId` applicationSid 稳定（而非旧 rename + 迁子表模型）、多个关键 invariant 节点缺失。

#### C-✅-1 [HIGH] Codex jsonl 路径画成 `~/.codex/projects/<encoded-cwd>/<sid>.jsonl` 完全错

- **图文件**：`ref/architecture/sdk-bridge-architecture.puml:31`
- **plantUML 原片段**：
  ```
  folder "~/.codex/projects/<encoded-cwd>/<sid>.jsonl" as CodexJsonl
  ```
- **src 实际状态**：`src/main/adapters/codex-cli/sdk-bridge/recoverer/jsonl-discovery.ts:11-13` 明文铁证：
  ```ts
  // **codex CLI jsonl 路径规则**:
  //   `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<TIMESTAMP>-<thread_id>.jsonl`
  //   YYYY/MM/DD = codex 创建 thread 时的本地日期；TIMESTAMP = 同时刻 ISO 字符串
  ```
  实现见 `jsonl-discovery.ts:40-61`：`~/.codex/sessions/<YYYY>/<MM>/<DD>/` ±1 day 扫描 + 递归兜底（REVIEW_56 §F2）。**路径与 cwd 完全无关**。
- **验证手段**：单方 codex 提出 + lead 现场 Read jsonl-discovery.ts 铁证。
- **修正方案**：CodexJsonl 节点改为 date-based 路径 `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<TS>-<thread_id>.jsonl`；注释强调 cwd-independent（与 Claude `~/.claude/projects/<encoded-cwd>` 分叉）。

#### C-✅-2 [HIGH] jsonl fallback 仍画「新建 + renameSdkSession」旧模型，src 已是 `fresh-cli-reuse-app` + `updateCliSessionId` 稳定 applicationSid

- **图文件**：
  - `ref/flows/sdk-bridge-resume-recovery-flow.puml:58`
  - `ref/flows/sdk-bridge-recovery-decision.puml:64-66`
  - `ref/architecture/sdk-bridge-state-machine.puml:67-75`
- **plantUML 原片段**：`createSession(opts) 无 resume` → `newRealSessionId` → `renameSdkSession(OLD, NEW)` → `sessions.set(NEW)`
- **src 实际状态**：Claude `src/main/adapters/claude-code/sdk-bridge/jsonl-fallback.ts:239-248` 调 `createSession` 带 `resumeMode='fresh-cli-reuse-app'` + `resume` 传 applicationSid；`stream-processor.ts:336-342` first real id 后 `sessionManager.updateCliSessionId(applicationSid, realId)`，**不迁 sessions.id 和子表**。Codex `codex-jsonl-fallback.ts:116-141` 同款 finalSessionId 不变。grep `fresh-cli-reuse-app|updateCliSessionId` 命中 30 文件（包括所有 sdk-bridge 关键路径）。
- **验证手段**：单方 codex 提出 + lead 现场 Grep 30 files 命中铁证。
- **修正方案**：
  1. 恢复流程图改 `fresh-cli-reuse-app → applicationSid unchanged → updateCliSessionId + OLD_CLI_ID blacklist`
  2. state-machine 的 fork/fallback 节点分清 spawn temp rename（首次 createSession 拿到 first real id 用 renameSdkSession）vs reverse-rename updateCliSessionId（applicationSid 稳定 cli_session_id 替换）

#### C-✅-3 [MED] state-machine 缺 4 关键 invariant 节点

- **图文件**：`ref/architecture/sdk-bridge-state-machine.puml:9-78`
- **src 实际状态 4 处铁证**：
  1. `pendingFileChangeIntents` Map cleanup（`types.ts:155` + `sdk-message-translate.ts:278,296` + `stream-processor.ts:442`）—— 实际是第 4 Map（图只画 3 Map）
  2. `interruptFired` idempotency guard（`types.ts:178-181`）
  3. `permissionModeChain` serialized async lock（`types.ts:206` + `index.ts:421,433`）
  4. `markRecentlyDeleted` 3-sid（applicationSid + cliSessionId × 2）60s blacklist（`pending-cancellation.ts:121,123,126`）
- **验证手段**：单方 claude 提出 + 给出 7 处具体 src:line 验证。
- **修正方案**：
  1. state-machine.puml 加 entity 6「pendingFileChangeIntents Map」（absent / set per toolUseId / cleared on stream end）
  2. entity 2 sdkOwned 扩 sub-state「interruptFired guard」
  3. 新 entity「permissionModeChain」（Promise chain serialize update）
  4. entity 5 加 dot 备注「rename 完成同步 markRecentlyDeleted 3-sid 60s blacklist 防 ghost session」

#### C-✅-4 [MED] resume-recovery flow 缺 PLACEHOLDER_DEDUP_MS 5s dedup + prependHistorySummary 5-state PrependFailReason

- **图文件**：`ref/flows/sdk-bridge-resume-recovery-flow.puml:42-53` + `ref/flows/sdk-bridge-recovery-decision.puml:24-44`
- **src 实际状态**：`constants.ts:58` `PLACEHOLDER_DEDUP_MS = 5_000`；`recover-and-send-impl.ts:229-235` placeholderEmittedAt Map 5s dedup。CHANGELOG_107 引入 prependHistorySummary 5-state fail reason（api-error / oversized / parse-error / placeholder-only / empty-history）。
- **验证手段**：单方 claude 提出 + 给出具体 src:line。
- **修正方案**：
  1. flow.puml 占位 message 旁加 note `5s dedup 窗口防快速并发触发同 sid 多次 emit (PLACEHOLDER_DEDUP_MS)`
  2. flow.puml 段 2 jsonl-missing fallback 添加 prependHistorySummary 5 fail state 分支
  3. decision.puml 段 1 自愈入口加 `if (5s 内已 emit 过同 sid 占位?) skip emit` 节点

#### C-✅-5 [MED] Codex cwd fallback 决策被画成强制 jsonl-missing fallback，实际 Codex 后续仍可正常 resume

- **图文件**：`ref/flows/sdk-bridge-recovery-decision.puml:56-64`
- **plantUML 原片段**：`强制走 jsonl-missing fallback 同款下游`
- **src 实际状态**：Claude cwd fallback 后进 fresh fallback；Codex 不一样 —— `src/main/adapters/codex-cli/sdk-bridge/recoverer/recover-and-send-impl.ts:140-142,237-242,254-276` 删除 `cwdFellBack ||` 强制 fallback，cwd fallback 后继续检查 jsonl，jsonl 在则正常 `resumeThread`，仅 jsonl 真缺失才 fresh fallback。
- **验证手段**：单方 codex 提出 + 给具体 src:line。
- **修正方案**：decision.puml 段 1 按 adapter 分叉：Claude cwd fallback → fresh-cli-reuse-app；Codex cwd fallback → cwd info emit + jsonl exists? normal resume : fresh fallback。

#### C-✅-6 [LOW] recovery flow 漏「入口先 emit user message 再做 cwd precheck」不变量

- **图文件**：`ref/flows/sdk-bridge-resume-recovery-flow.puml:45-56`
- **plantUML 原片段**：流程从 `cwdExists(row.cwd)?` 开始，未含 user message 入库。
- **src 实际状态**：Claude `recover-and-send-impl.ts:109-139` + Codex `recover-and-send-impl.ts:110-135` 都在长度校验后、cwd precheck 前立即 emit `role='user'` event，保证 cwd 全 miss / createSession fail 时用户气泡不丢。
- **验证手段**：单方 codex 提出 + 给具体 src:line。
- **修正方案**：flow 的 recoverer 入口补 `emit role=user message + attachments` 节点，再进 cwd precheck / placeholder / fallback。

#### C-❓-1 [MED → 降级 LOW] aux helper 对偶不对仗

- **图文件**：`ref/architecture/sdk-bridge-architecture.puml:14-24`
- **plantUML 原片段**：claude aux 列 3 模块（stream-processor + restart-controller + canUseTool），codex aux 列 6 模块（thread-loop + options-builder + rollback + resume-await + token-map + ErrorItem filter）—— 对偶维度对不上。
- **裁决**：本质是图表达美观 / 信息密度问题，不算 SSOT 失真。**待用户决策**。
- **修正方案**（如改）：双端 aux 都改成统一 4 grouping `stream / restart / permission / fallback`；或 note bottom 加表格做镜像对应。

#### C-✅-7 [INFO 顺手修] `src/main/adapters/claude-code/sdk-bridge/index.ts:374` 注释 stale「清三 Map」实际已是 4 Map

- **非 .puml drift 但同根**：claude 顺手列出，与 C-✅-3 同根（pendingFileChangeIntents 已加成第 4 Map 但旁注释停留在 3 Map 时代）。
- **修正方案**：注释 `// 详见该 helper jsdoc：清三 Map / sessions.delete / releaseSdkClaim / markRecentlyDeleted` → 改 `清四 Map`。

---

### D. agent-deck-mcp + universal-message 主题（5 图）

整体一致度：**中等偏低** —— MCP tool guard 总体对；universal-message-watcher 运行机制（event+poll 混合）、claim 后状态守门、fairness backpressure、hand-off spawn guard 语义、in-process transport 多处实质失真。

#### D-✅-1 [HIGH] universal-message-status-state-machine 缺 `Pending → Delivered` 直跳边（REVIEW_32 HIGH-1 spawn 捷径路径）

- **图文件**：`ref/architecture/universal-message-status-state-machine.puml:18-19`
- **plantUML 原片段**：
  ```
  Pending --> Delivering : claim (原子 UPDATE WHERE status='pending')
  Delivering --> Delivered : markDelivered (成功)
  ```
- **src 实际状态**：`src/main/store/agent-deck-message-repo/state-machine.ts:41-58` `markDelivered` SQL `WHERE id = ? AND status IN ('pending', 'delivering')`。REVIEW_32 HIGH-1 fix：spawn_session 路径 createSession 已投过 prompt 立刻 insert placeholder (status='pending') + markDelivered 做捷径，watcher 250ms poll 100% no-op 防双投递。
- **验证手段**：单方 claude 提出 + lead 现场 Read `state-machine.ts:48-58` SQL 铁证。
- **修正方案**：state-machine.puml:18-19 之间加：
  ```
  Pending --> Delivered : markDelivered (spawn 捷径\nbypass claim, REVIEW_32 HIGH-1)
  ```
  note N1 加不变量「Pending 双出口：claim 转 Delivering 主路径 / markDelivered 直跳 Delivered 捷径」。

#### D-✅-2 [HIGH] agent-deck-mcp-architecture tool 入口只画 2 transport（stdio + HTTP），实际 3 transport（in-process + stdio + HTTP）

- **图文件**：`ref/architecture/agent-deck-mcp-architecture.puml:11`
- **plantUML 原片段**：`[tool 入口 (15 tools)\nstdio + HTTP /mcp] as Entry`
- **src 实际状态**：`src/main/agent-deck-mcp/server.ts:4-9` jsdoc 明文「三 transport 共享同一份 buildAgentDeckTools 输出」：in-process (B'3 createSdkMcpServer) + HTTP (B'4 /mcp route) + stdio (B'1 StdioServerTransport)。in-process 是 in-app caller **默认 + 唯一**通道。
- **验证手段**：单方 claude 提出 + lead 现场 Read server.ts:1-60 jsdoc + line 47 `transport: 'in-process'` 铁证。
- **修正方案**：
  1. agent-deck-mcp-architecture.puml:11 改 `[tool 入口 (15 tools)\nin-process + stdio + HTTP /mcp] as Entry`
  2. note 节加描述「in-process 为 in-app caller 默认通道（EXTERNAL_CALLER_ALLOWED 矩阵决定 deny/allow）；stdio + HTTP 为外部 client」

#### D-✅-3 [MED] tool-call-flow 把 hand_off 内 spawn 画成走三道 spawn-guards，实际 handOffMode 全跳且不写 spawn-link

- **图文件**：`ref/flows/agent-deck-mcp-tool-call-flow.puml:53-55`
- **plantUML 原片段**：`走 spawn 控制器 (spawn / hand_off 内 spawn) → spawn handler + 三道防御`
- **src 实际状态**：`hand-off-session/handler-main.ts:234-249` spawn 时传 `{ handOffMode: true, batonRole: 'lead' }`；`spawn-guards.ts:52-60` 明确 handOffMode 跳 depth/fan-out/rate 三道；`spawn.ts:289-313` handOffMode 不写 `sessions.spawned_by`/`spawn_depth`。
- **验证手段**：单方 codex 提出 + 给具体 src:line。
- **修正方案**：tool-call-flow 的 spawn 分支拆 `普通 spawn_session` vs `hand_off internal spawn` 两条；hand-off 条标注 `skip guards + no spawn-link`。

#### D-✅-4 [MED] watcher 被画成纯 250ms poll，实际是 event + 50ms debounce + 250ms poll fallback

- **图文件**：
  - `ref/architecture/agent-deck-mcp-architecture.puml:31`
  - `ref/flows/universal-message-dispatch-flow.puml:27-30`
  - `ref/flows/universal-message-dispatch-decision.puml:8`
- **plantUML 原片段**：`[消息派发轮询器\n(250ms poll)]`
- **src 实际状态**：`src/main/teams/universal-message-watcher/index.ts:141-148` event (`agent-deck-message-enqueued`) + interval 双路径；`172-183` 50ms debounce；`189-257` processing single-flight + reschedule。
- **验证手段**：单方 codex 提出 + 给具体 src:line。
- **修正方案**：图改为 `eventBus enqueue → 50ms debounce process` + `250ms poll fallback`，补 single-flight / reschedule 节点。

#### D-✅-5 [MED] dispatch claim 成功后直接 adapter dispatch，漏 stale ACL / lifecycle / capability 重验

- **图文件**：
  - `ref/flows/universal-message-dispatch-flow.puml:37-47`
  - `ref/flows/universal-message-dispatch-decision.puml:38-44`
- **src 实际状态**：`universal-message-watcher/index.ts:286-407` claim 后先重验 target exists/closed/archived、from exists/archived、team exists/archived、from/to active membership、adapter registered/canCollaborate；失败走 `markFailed`，不 dispatch。
- **验证手段**：单方 codex 提出 + 给具体 src:line。
- **修正方案**：claim 成功后、adapter dispatch 前新增 `stale ACL revalidation` 决策块；失败转 `markFailed(reason)` terminal。

#### D-✅-6 [MED] fairness / backpressure 触发条件错 + 漏 starvation guard

- **图文件**：`ref/flows/universal-message-dispatch-decision.puml:23-31` + `dispatch-flow.puml:31-34`
- **plantUML 原片段**：`if (候选全部同 target?) then findEligibleExcludingTargets LIMIT 1`
- **src 实际状态**：`universal-message-watcher/index.ts:203-229` 先 per-candidate backpressure check，若全 skip 则强制 deliver `candidates[0]`（starvation guard）；`230-247` cross-target fairness 触发条件是 `candidates.length >= BATCH_LIMIT`，排除本批所有 targets，**不要求**「候选全部同 target」。
- **验证手段**：单方 codex 提出 + 给具体 src:line。
- **修正方案**：决策树改为 `findEligible → per-candidate otherInflight check → if deliveredAny=false force deliver first → if batch full query excluding batchTargets`。

#### D-✅-7 [MED] dispatch 图缺 PerKeyRateLimiter（60 msg/60s/teamId）

- **图文件**：`ref/flows/universal-message-dispatch-flow.puml:36-43` + `dispatch-decision.puml:34-41`
- **src 实际状态**：`src/main/teams/universal-message-watcher/rate-limiter.ts` 实存。lead 现场 Grep 命中。
- **验证手段**：单方 claude 提出 + lead 现场 Grep `PerKeyRateLimiter` 命中文件铁证。
- **修正方案**：flow.puml 段 2 claim 之前加 `PerKeyRateLimiter check (60 msg / 60s / teamId)` step；decision.puml 段 3 同理加 if 节点。

#### D-✅-8 [MED] dispatch 图缺 TeamEventDispatcher（preseed lastArchivedAt + offCreated listener）

- **图文件**：`ref/flows/universal-message-dispatch-flow.puml`（全文未出现 TeamEventDispatcher）
- **src 实际状态**：`src/main/teams/universal-message-watcher/team-event-dispatcher.ts` 实存。REVIEW_35 R2 HIGH-A1 修法：preseed lastArchivedAt 缓存 + offCreated listener 防 team archived 时已入队 message 还被 dispatch。
- **验证手段**：单方 claude 提出 + lead 现场 Grep `TeamEventDispatcher` 命中文件铁证。
- **修正方案**：加 participant `TeamEventDispatcher`，段 2 claim 之前 + 段 3 派发之前加 listener check 节点；或单独画 cross-ref note。

#### D-✅-9 [LOW] state-machine 漏 markFailed 从 pending 直迁

- **图文件**：`ref/architecture/universal-message-status-state-machine.puml:20-28`
- **plantUML 原片段**：只画 `Delivering → Failed : retryAfterFail(attempt >= MAX_RETRY)`
- **src 实际状态**：`state-machine.ts:60-67` `markFailed` SQL `WHERE id = ? AND status IN ('pending', 'delivering')`；watcher `index.ts:288-407` 多处调 markFailed（stale ACL / adapter missing）从 pending 直接进 failed。
- **验证手段**：单方 codex 提出 + lead 现场 Read 铁证。
- **修正方案**：补 `Pending --> Failed : markFailed(stale ACL / target missing / cancelled-by-caller)` 与 `Delivering --> Failed : markFailed(...)`。

#### D-❓-2 [MED 未验证] EXTERNAL_CALLER_ALLOWED 矩阵在 tool-call-flow 入口拦截分流是否 explicit

- **图文件**：`ref/flows/agent-deck-mcp-tool-call-flow.puml`
- **claude reviewer 自承未读 tool-call-flow.puml 具体内容**（只看 INDEX 概要）。
- **裁决**：**待 user 决策是否单独 spot-check** 该图是否含 `if (transport in EXTERNAL_CALLER_ALLOWED[toolName] === false) reject` 节点；如已含 → 不修；如未含 → 加 entry 拦截节点。

#### D-❓-3 [LOW] MAX_RETRY note 措辞精化 + INDEX 第 3 列加 commit reference

- 已基本 OK，**user 自决**是否做信息密度精化。

---

### INDEX.md 概要列陈旧

#### INDEX-✅-1 [LOW] archive-plan 概要"7 步原子"

- **文件**：`ref/architecture/INDEX.md:8` + `ref/flows/INDEX.md:8`
- **概要片段**：`archive_plan 模块架构(...,7 步原子时序主链路)`、`archive_plan 7 步原子收口 sequence`
- **修正方案**：与 A-✅-1 同根，改成「precheck fail-fast + post-ff-merge manual recovery + cleanup」。

#### INDEX-✅-2 [LOW] sdk-bridge / universal-message 概要传播旧 rename / 250ms poll

- **文件**：`ref/architecture/INDEX.md:13` + `ref/flows/INDEX.md:14`
- **修正方案**：与 C-✅-2 / D-✅-4 同根，改成 `applicationSid stable + cli_session_id update` / `event+poll hybrid dispatch`。

---

## 汇总修正 checklist（按文件分组）

### 必修（HIGH 6 条 + 同根 LOW 2 条）

| # | 文件 | 修改点 |
|---|---|---|
| H1-H4 | `archive-plan-{architecture,flow,precheck-decision,state-machine}.puml` | "7 步原子" → "4 子模块原子收口"；post-ff-merge 失败兜底改 manual recovery；step 序号按子模块分组 |
| H5 | `hand-off-session-{architecture,flow,decision,state-machine}.puml` 4 图 | phase 1 跳过条件 2 → 6 状态完整 enum；entity 3 子态扩 5 子态 |
| H6 | `sdk-bridge-architecture.puml:31` | CodexJsonl 节点改 date-based `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<TS>-<thread_id>.jsonl` + 注释 cwd-independent |
| H7 | `sdk-bridge-resume-recovery-flow.puml:58` + `recovery-decision.puml:64-66` + `state-machine.puml:67-75` | 改 `fresh-cli-reuse-app → applicationSid 稳定 → updateCliSessionId`；区分 spawn temp rename vs reverse-rename updateCliSessionId |
| H8 | `universal-message-status-state-machine.puml:18-19` | 加 `Pending → Delivered` 直跳边（markDelivered spawn 捷径 REVIEW_32 HIGH-1）|
| H9 | `agent-deck-mcp-architecture.puml:11` | tool 入口 "stdio + HTTP /mcp" → "in-process + stdio + HTTP /mcp" + note 描述 |
| L1 | `ref/architecture/INDEX.md:8` + `ref/flows/INDEX.md:8` | archive-plan 概要同步改 |
| L2 | `ref/architecture/INDEX.md:13` + `ref/flows/INDEX.md:14` | sdk-bridge / universal-message 概要同步改 |

### 应修（MED 11 条）

| # | 文件 | 修改点 |
|---|---|---|
| M1 | `archive-plan-{flow,precheck-decision}.puml` 4 态 partition | 标题加 "(笛卡尔积 cwdValid × inWorktree × markerReal)"；4 态扩 8 分支 + `releaseMarkerOnSuccess` 字段 |
| M2 | `hand-off-session-architecture.puml:51-54` | adopt-task 顺序调整为 `prepareAdopt → spawn → swapLead → taskReassign`；调用箭头加 (pre/post-spawn) 标签 |
| M3 | `hand-off-session-architecture.puml:13-17` | L2 package 拆 4 子节点（facade / cwd-resolver / team-adopt-coordinator / task-reassign-coordinator）|
| M4 | `sdk-bridge-state-machine.puml` | 加 entity 6 pendingFileChangeIntents + entity 2 sub-state interruptFired + 新 entity permissionModeChain + entity 5 旁注 markRecentlyDeleted 3-sid |
| M5 | `sdk-bridge-resume-recovery-flow.puml:42-53` | 占位 message 旁加 5s dedup note（PLACEHOLDER_DEDUP_MS）+ 段 2 加 prependHistorySummary 5 fail state 分支 |
| M6 | `sdk-bridge-recovery-decision.puml:24-44` + `:56-64` | 段 1 加 5s dedup if 节点；段 1 按 adapter 分叉 Claude/Codex cwd fallback 后续路径 |
| M7 | `agent-deck-mcp-tool-call-flow.puml:53-55` | 拆 `普通 spawn_session` vs `hand_off internal spawn` 两条；hand-off 条标 skip guards + no spawn-link |
| M8 | `agent-deck-mcp-architecture.puml:31` + `universal-message-dispatch-flow.puml:27-30` + `dispatch-decision.puml:8` | watcher 改 `eventBus enqueue → 50ms debounce process` + `250ms poll fallback` + single-flight/reschedule 节点 |
| M9 | `universal-message-dispatch-flow.puml:37-47` + `dispatch-decision.puml:38-44` | claim 后 adapter dispatch 前加 stale ACL/lifecycle/capability 重验决策块；失败转 markFailed terminal |
| M10 | `universal-message-dispatch-decision.puml:23-31` + `dispatch-flow.puml:31-34` | fairness 决策树改为 per-candidate backpressure + starvation guard + batch-limit fairness |
| M11 | `universal-message-dispatch-flow.puml:36-43` + `dispatch-decision.puml:34-41` + `dispatch-flow.puml` 全文 | 加 PerKeyRateLimiter (60 msg/60s/teamId) + TeamEventDispatcher (preseed lastArchivedAt + offCreated listener) 节点 |

### 选修（LOW / INFO 3 条）

| # | 文件 | 修改点 |
|---|---|---|
| LO1 | `sdk-bridge-resume-recovery-flow.puml:45-56` | 入口补 `emit role=user message + attachments` 节点 |
| LO2 | `universal-message-status-state-machine.puml:20-28` | 补 `Pending --> Failed : markFailed(stale ACL / target missing / cancelled-by-caller)` 与 `Delivering --> Failed : markFailed(...)` |
| I1 | `src/main/adapters/claude-code/sdk-bridge/index.ts:374` | 注释 "清三 Map" → "清四 Map"（非 .puml 但同根）|
| I2 | `src/main/agent-deck-mcp/tools/handlers/baton-cleanup.ts:8-11` | jsdoc "skipped: 'caller-not-lead' | 'adopt-keep-implicit' | null" 三态 → 六态（非 .puml 但同根）|

### 待 user 决策（4 条）

| # | 文件 | 待决问题 |
|---|---|---|
| Q1 | `sdk-bridge-architecture.puml:14-24` | aux helper 对偶不对仗（claude 3 vs codex 6）—— 是否改成统一 4 grouping (stream/restart/permission/fallback)？|
| Q2 | `agent-deck-mcp-tool-call-flow.puml` | EXTERNAL_CALLER_ALLOWED 矩阵入口拦截节点是否需补？需先 spot-check 当前是否含该节点 |
| Q3 | `archive-plan-architecture.puml:69-72` | "fs/git 公共助手 10 个" 数字魔术常数 —— 改 "若干" 或加 INDEX reference？ |
| Q4 | `universal-message-status-state-machine.puml:42` | MAX_RETRY note 精化 + REVIEW_61 LOW-α 引用是否值得？ |

### 反驳（不修，1 条）

- **B-❌-1** `hand-off-session-state-machine.puml:50-54` 30min grace 自动归档 —— reviewer-claude *未验证* 候选，lead 现场 Grep `team-lifecycle-scheduler.ts:36,45,49,124` 实证 invariant 仍 enforce 图正确，**不修**。

---

---

## R2 verify + R2 fix (4 过修)

R1 23 ✅ fix 实施后, R2 双 reviewer verify `git diff HEAD` 发现 4 条 R1 过修 finding (lead 修法引入 src 不存在节点 / 与 src 语义偏离)。

| R2 finding | 来源 | 验证 | 终态 |
|---|---|---|---|
| **archive-plan precheck inWorktree + marker mismatch 改 warn pass 不符 src reject** | codex R2-H1 单方 | lead 现场 Read `impl-precheck.ts:274-279` 铁证 reject + end | ✅ HIGH 必修 |
| **PerKeyRateLimiter 不在 watcher dispatch 二次 check** | codex R2-M1 + claude R2-MED-1 **双方独立** | lead 现场 Read `enqueue.ts:48-58` (send_message 入队前唯一 check) + `index.ts:203-247` (watcher 0 rate-limit) 双重铁证 | ✅ MED 必修 (强冗余) |
| **TeamEventDispatcher 不参与 dispatch gating** | codex R2-M2 单方 | lead 现场 Read `team-event-dispatcher.ts:1-9` jsdoc (best-effort observational fan-out, watcher lifecycle 联动启停) + `index.ts:336-352` stale ACL block 铁证 | ✅ MED 必修 |
| **archive-plan ④/⑤ narrative flow vs decision 不一致** | claude R2-INFO-1 单方 | flow.puml:36-37 narrative pin 准确 (按 `impl-precheck.ts:286-308` c-1/c-3 语义); decision.puml 与之矛盾 | ✅ INFO 修 (narrative 对齐 flow.puml) |

**R2 fix 实施 4 处 (4 文件 / 157+ / 93-)**:

- **F1 (HIGH)**: `archive-plan-precheck-decision.puml:30-32` + `archive-plan-flow.puml:34` — cwd valid + inWorktree + marker mismatch 改 reject + end + hint (`exit_worktree(markerReal)` 或匹配 marker 的 `worktree_path`)
- **F2 (MED)**: `universal-message-dispatch-flow.puml:10,60-66` + `decision.puml:11,39-43` — 删 watcher per-candidate PerKeyRateLimiter 二次 check; RL participant 描述改 "send_message 入队前 check 一次"; loop 内加注释 "M11: PerKeyRateLimiter 已在 send_message 入队前 check 一次, watcher 不再二次 check"
- **F3 (MED)**: `universal-message-dispatch-flow.puml:11,44-49` + `decision.puml:11-12` — 删 TED participant + 删 dispatch 主链路 TED check 节点; Watcher note 加 "**lifecycle 旁路**: watcher.start() 联动 teamEventDispatcher.start() (best-effort fan-out, 独立于 dispatch 主链路不 gating; team archived gating 在 stale ACL)"
- **F4 (INFO)**: `archive-plan-precheck-decision.puml:35-37` — ④/⑤ narrative 对齐 flow.puml (marker==worktreePath = "残留 mcp marker, builtin ExitWorktree 不清" + releaseMarkerOnSuccess+warn; marker==null = "默认 caller 已 ExitWorktree keep / 历史 plan / 手工建")

---

## R3 verify ✅ 收口

R2 fix 实施后 R3 send_message 给两 reviewer (focus 严格 R2 fix-to-fix 范围, 不再扩 R3 finding)。

- **reviewer-claude R3**: ✅ R3 可合。4 fix 全 land + 与 src 对齐 (`impl-precheck.ts:274-279` / `enqueue.ts:48-58` / `team-event-dispatcher.ts` / `index.ts:286-407`) + 跳过项 unchanged + R3 scope 严格遵守。
- **reviewer-codex R3**: ✅ R3 可合。R2 4 fix 全 land 且与 src 对齐。未发现 R3 范围内新偏离; Q1-Q4 与 B-❌-1 未被本轮动到。

满足 SKILL §收口 判定: 双方共识可合 + 0 HIGH/MED + R2 fix 全 verify ✅。R3 收口后 shutdown 两 reviewer (`shutdown_session` × 2, 数据保留可查)。

---

## 最终累计

| 轮 | finding 数 | 实施 |
|---|---|---|
| R1 | codex 13 + claude 18 = 23 unique (HIGH 6 + MED 11 + LOW/INFO 6 + ❓ 5 + ❌ 1) | 23 ✅ 全实施 (22 文件 / 437+ / 197-) |
| R2 verify | codex 1 HIGH + 2 MED + claude 1 MED + 1 INFO = 4 过修 finding (PerKeyRateLimiter 双方独立 强冗余) | 4 fix 全实施 (4 文件改动叠加 R1) |
| R3 verify | 双 reviewer ✅ 可合 (0 新 finding) | — |

**最终 working tree**: 22 文件 / 430+ / 196- 累计 + REVIEW_64.md untracked (本份 review 报告)。

**异构对偶价值教科书级 case**:

- **R1**: codex 抓「实测路径 / 失败语义边界 / Codex jsonl date-based / spawn-guards handOffMode 跳 / watcher event+debounce 实现细节」, claude 抓「baton skipped 6 状态完整 enum / state-machine 边缺失 / in-process transport 缺失 / facade 子模块拆分 / state-machine invariant 节点缺失」零交叉
- **R2**: codex 单方抓 H1 (archive-plan inWorktree marker mismatch reject) + M2 (TED dispatch gating) — 同源化 claude 会同时漏; **PerKeyRateLimiter 双方独立提出 = 强冗余** 体现 R2 fix-to-fix 阶段异构对抗仍能挖出 R1 修法过修 finding
- **R3**: 双 reviewer 严格 fix-to-fix scope 快速 PASS, 验证 SKILL R3 严格只看本轮 fix-to-fix 协议有效

**SKILL 学习点**:

- prompt asset / SSOT 文档失真度 review 与 code review 同款严格 (.puml 是 design SSOT, 失真直接误导后续 caller / reviewer)
- general-purpose Agent 隔离 context 批量 Edit 大规模 prompt asset (21 文件 / 39 处 Edit) 是 lead 主会话 context 管理高 ROI 路径; lead 用 grep verify + spot check + R2 让 reviewer 双 verify 三层防御
- R1 修法 lead 易 "过修" — trust 修法对会引入新失真; R2 verify 走 fix-to-fix scope 抓 R1 fix 残留 / 过修 / 引入新问题, 是 fix-loop 不可省略的一轮
- **PerKeyRateLimiter R2 双方独立提出** 是 R1 修法过修被双 reviewer 同根抓出的教科书案例 — 验证 deep-review SKILL 多轮异构对抗在 fix-to-fix 阶段仍有强冗余价值

---

## 关联 changelog

待 user 决定 commit 时机后落 `ref/changelogs/CHANGELOG_<NEXT_X>.md` (同步本份 review 编号 REVIEW_64)。
