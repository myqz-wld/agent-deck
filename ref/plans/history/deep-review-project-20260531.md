---
plan_id: "deep-review-project-20260531"
created_at: "2026-05-31T11:00:00+08:00"
status: "completed"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-project-20260531"
base_commit: "7f96617e00ac6eca5cce0186bf3aa2ed042a4aca"
base_branch: "main"
final_commit: "8bcb13864d77d6e68d057d1d2d3d00c88bc466be"
completed_at: "2026-06-01"
---
# Deep Review 整个项目 — 多轮异构对抗 review × fix 收口

## 总目标

对 agent-deck 项目做全面 deep review，聚焦三类：
1. **功能 BUG**（race / leak / 边角 / null / 错变量 / 协议不一致 / 数据正确性）
2. **代码优化**（重复逻辑 / 低效查询 / 资源清理 / 可简化）
3. **文字措辞优化**（UI 文案 / 注释 / tool description / 用户可见字符串）

走 `agent-deck:deep-review` SKILL（多轮异构 reviewer 对抗 reviewer-claude + reviewer-codex + 三态裁决）。

## ⚠️ 用户授权（本次会话核心约束 — 写入 plan 按用户要求）

用户原话：「deep review 下项目，聚焦于功能 BUG、代码优化和文字措辞优化，我要离开一会儿，**你一路推进，自主决定 hand off 时机**，这个授权写入到 plan 里」。

**授权范围**（standing authorization，跨会话有效直到用户回来或 plan 收口）：
- ✅ **自主一路推进**：无需逐步等用户确认即可执行 review → fix → review 循环；HIGH finding 直接修，MED 现场验证后修，LOW/INFO 记录
- ✅ **自主进 worktree + 自主 commit**：fix 落 worktree，每批次 commit（这是用户明确授权的破坏性改动隔离）
- ✅ **自主决定 hand off 时机**：context 接近上限 / 完成独立批次 / mental model 重叠度低时，自主走 `hand_off_session` 接力新会话，无需问用户
- ✅ **自主 spawn / shutdown reviewer teammate**
- ❌ **边界**：不做超出「review + fix bug/优化/措辞」范围的功能性改动；不删用户数据；不 push 到 remote；不改协议级 breaking change（除非 review 发现的明确 bug 修复）。涉及核心流程/架构变更需画 plantUML 的，先记入 plan §待办 留给用户回来确认（不自主画）

## 设计决策（不再争论）

1. **worktree 隔离**：fix 落 `.claude/worktrees/deep-review-project-20260531/`，主分支零污染，失败可整片回退（理由：跨多会话 + 破坏性 fix，符合应用 CLAUDE.md §复杂 plan workflow）
2. **跳过 Step 1.5 plan deep-review**：本 plan 是「授权 + review 批次跟踪」文档，非 design plan（无不变量 / 无协议设计），无 design 决策可评审 → justified exception
3. **descope 刚审过的代码**：issue-tracker 主体（store/issue-repo.ts / ipc/issues.ts / mcp issue handlers）在 HEAD commit REVIEW_70（2026-05-31 当天）刚审过 → 降到最低优先级（Batch H 末，时间不够可跳）。renderer 的 issue 组件（IssueDetail/IssuesPanel/ResolveInNewSessionDialog）含 6 处近期改动 + 文案密集 → 保留在 renderer 批次
4. **批次粒度** ≤ 10 文件 / 批，按子系统内聚拆分；优先级 = 风险 × 复杂度 × review 新鲜度衰减
5. **异构对抗物理保证**：reviewer-claude（claude-code adapter, Opus 4.7）+ reviewer-codex（codex-cli adapter, gpt-5.5），lead 自己做三态裁决
6. **fix 收口纪律**：每批次 review 收口（0 HIGH/MED + 双方可合）后 commit + 写/更新 REVIEW_X.md，再进下一批

## 批次 checklist（按优先级；路径为主仓库相对，review 时加 worktree 前缀）

> 优先级排序理由：orchestration + 并发/recovery 是 subtle bug 高发区 → 排前；renderer 文案 → 中；刚审过的 → 末。

- [x] **Batch A — MCP hand-off + worktree handlers**（最复杂 orchestration）✅ 收口
  - [x] A1 hand-off orchestration（commit 826af22 / REVIEW_71）
  - [x] A2 worktree handlers（commit 08db5e8 / REVIEW_72）
- [ ] **Batch B — MCP archive-plan**（多 phase 收口事务）
  - [x] B1 facade + precheck + ff-merge（commit ba0b609 / REVIEW_73）
  - [x] B2 剩余: `_impl-shared.ts` / `impl-archive-fs.ts` / `impl-cleanup.ts` / `precheck-helpers.ts` / `index-sync-helpers.ts`（commit 7d82896 / REVIEW_74）：HIGH isPostCommitArchiveError regex [a-z-]+ 漏判大写 phase（双方独立+node 实测，补 B1 漏覆盖 2/3 phase）/ MED INDEX 单飞锁 set-after-await 退化丢行 + finally 无 identity check（双方独立+harness 实测）/ INFO rename display 反向 + 15 回归 test
- [x] **Batch C — adapters claude-code sdk-bridge**（recovery / 并发 / lifecycle）✅ 收口（C1-C4 全 27 文件，commit d620ac4/28b0887/82b951d/28cdd3b / REVIEW_75-78）
  - `src/main/adapters/claude-code/sdk-bridge/*.ts`（index/recoverer/stream-processor/session-finalize/restart-controller/jsonl-fallback/query-options-builder/mcp-server-init）
  - 拆 4 子批 C1-C4（27 文件 ~5569 LOC），复用同一 reviewer pair（team dr-project-c-20260531 / claude 2fc6617f / codex 019e7c9d）
  - [x] **C1 — entry + create-session + options builder**（10 文件 ~1644 LOC，commit d620ac4 / REVIEW_75）✅ 收口：HIGH createSession 失败落孤儿 tempKey DB row（codex + lead emit→ingest→dedupOrClaim 全链 trace，catch 补 sessionRepo.delete(tempKey)）/ MED orchestrator prepare→finalize 无 try/catch resolver 抛错漏清（claude + diff 非回归，包 try/catch 幂等清理）/ MED claimAsSdk(realId) 自然 end 漏释放 CLI sid（codex + lead trace，finally mirror 三面释放）/ 5 INFO 文档 + 5 回归 test 全 temp-revert 非空验证
  - [ ] **C2 — recoverer**（6 文件 ~1230 LOC：recoverer/recoverer-helpers/recoverer-messages + recoverer/_deps/recover-and-send-impl/jsonl-discovery）✅ 收口（commit 28b0887 / REVIEW_76）：⚠️ 异构 divergence（codex 2 MED / claude 0 MED→反驳轮 ✅ 同意）。MED-1 recovery 失败前 user emit 把 closed 复活成 active 不回滚 dead-active 幽灵（wasClosed + markClosed 回滚）/ MED-2 listEventsFn 在 try 外破坏「永不抛错」契约（纳入 try/catch）/ INFO resume-fork 注释漂移 + 2 INFO by-design。+5 回归 test 全 temp-revert 非空验证
  - [x] **C3 — stream + translate + finalize**（5 文件 ~1386 LOC，commit 82b951d / REVIEW_77）✅ 收口：**双方独立收敛 clean 0 HIGH/0 MED**（fresh pair dr-project-c3，旧 pair closed 重 spawn）。3 INFO fix（CHANGELOG_<X>→CHANGELOG_61 占位符回填双方独立 / race guard 注释废弃 realSessionId 三档链重写 codex / C1 cliSid release 注释精确化主因是 Set 泄漏非 dedup claude）+ 1 LOW ❌ 不改代码（C1 cliSid release 不 mirror 黑名单 = 刻意设计正确：dormant 允许复活，lead 更正 reviewer「黑名单只挡 hook」事实错误 manager.ts:320 不区分 source）。C1/C2 已修点经 fresh pair 复查全部正确。comment-only 无新回归 test，typecheck + sdk-bridge 73 passed
  - [x] **C4 — permission + tool + restart + cancel**（4 文件 ~1332 LOC，commit 28cdd3b / REVIEW_78）✅ 收口（**Batch C 收官**）：异构 divergence（codex 2 MED / claude 1 MED 注释 + 显式反驳 codex MED-2）。MED-1 ✅ ExitPlanMode approve 热切档不同步 internal.permissionMode cache + 失败只 log（codex + lead 验证；canUseTool getPermissionMode 读脏 cache + 下次 rollback baseline 脏 + 失败不回滚 DB/无 error）→ optimistic cache 同步 + catch 回滚 + error emit。LOW ✅ cancelPendingAndEmit 不 resolve SDK promise（codex 提 MED → claude 显式反驳 → lead 裁 LOW，worst-case GC'd 悬挂 promise 非泄漏，仍防御性 fix best-effort resolve 幂等）。INFO ✅ 双方独立 realSessionId 注释漂移 5 处。+5 回归 test（2 MED fix 全 temp-revert 各挂 2 test）。can-use-tool.ts:43 realSessionId 残留已修
- [x] **Batch D — adapters codex-cli sdk-bridge**（28 文件全量 ~4379 LOC，拆 4 子批 D1-D4，fresh pair dr-project-d-20260531）✅ **全收官**（REVIEW_79-82 / 7 bug fix + 10 INFO + 21 回归 test；含 1 MED 证伪 = 异构对抗拦误报）
  - `src/main/adapters/codex-cli/sdk-bridge/*.ts` + `create-session/*` + `recoverer/*` + `codex-instance-pool.ts` + `translate.ts` + `index.ts`/runners
  - [x] **D1 — create-session + entry**（10 文件 ~1382 LOC，commit 58e214e / REVIEW_79）✅ 收口（**Batch D 开篇**）：异构 divergence（codex 0H/0M/0L+2INFO「主链路干净」/ claude 0H/1MED logic 单方+1MED 测试缺口+3INFO；两 reviewer 测试缺口+thread-options-builder doc 独立收敛）。MED-1 ✅（claude 单方+lead temp-revert 复现）create-session-impl.ts:151 resume internal.threadId 初值用 applicationSid 而非 cli-sid → reverse-rename 后 normal resume 误触 thread-loop case-3 fork（误导 warn+latent 脆弱，当前 updateCliSessionId(A,C) oldCliSid===C 不写黑名单故无数据损坏；codex 独有 claude-parity 偏差）→ `effectiveResumeThreadId ?? opts.resume ?? null`。MED-2 ✅（双方独立）rollback 枚举路径+thread-options-builder 零 test → +10 test。4 INFO ✅（9 字段→7 / additionalDirectories 漏 /tmp / 同 row get 读两次 / void sandboxMode 注释）。codex-cli 131 passed（121+10）
  - [x] **D2 — thread-loop + translate + finalize + restart**（5 文件 ~1390 LOC，commit 68baae9 / REVIEW_80）✅ 收口：MED ✅（双方独立共识）restart-controller.ts:129 forward setCodexSandbox 在 closeSession 后、createSession try **外**裸调 → DB write throw（SQLITE_BUSY）跳过 catch → 卡占位文案无 error bubble + 违反 ipc:395 契约；claude 补 (a) 回滚自身裸调掩盖原 err (b) claude:378 同款 parity-shared latent（follow-up）→ forward 纳入 try + 回滚包 try/catch。LOW ✅（双方独立同向）translate.ts:403 loader-filter OR-any `'failed to deserialize'` 单独命中吞真 turn error → 收窄到 `'Ignoring malformed'` 锚点。INFO ✅ 映射表注释 + INFO ❓ 未验证 双 finished（follow-up 不投机改）。codex-cli 135 passed（131+4，2 MED temp-revert 非空）
  - [x] **D3 — recoverer**（recoverer/* + codex-recoverer-messages + codex-jsonl-fallback + resume-path-await）✅ 收口（6 文件 ~974 LOC，commit 18bfc50 / REVIEW_81）：MED-1 ✅（双方独立共识 + lead 全链 trace；C2 claude MED-1 codex 对称缺口未跟修）recover-and-send-impl.ts:127 入口 emit user message → 共享 ingest → ensure closed→active 复活，codex 只读 archivedAt 不读 lifecycle → 两失败路径不回滚 dead-active 幽灵；claude 提 HIGH/codex 提 MED/lead 裁 MED 对齐 C2 → wasClosed + 两路径 markClosed。MED-2 ✅（codex 单方 + lead claude parity）codex-jsonl-fallback.ts:108 fallback info emit 在 createSession 前 → reject 时时间线矛盾 → 移到 createSession 后。LOW ❓ 时区边界不改（递归扫兜底）。C2 listEventsFn 在 codex 不适用。codex-cli 140 passed（135+5，2 MED temp-revert 非空 + 2 边界 case 证 guard 精确）
  - [x] **D4 — binary + pool + adapter runners**（7 文件 ~653 LOC + 连带 oneshot-llm/codex-runner，commit d510cb3 / REVIEW_82）✅ 收口（**Batch D 收官**）：异构 divergence（claude 0H/0M/1LOW/3INFO + win32 PATH 逐行对照 SDK dist 确认 REVIEW_69+70 无回归；codex 0H/2MED）。MED-1 ✅（codex 单方 + lead 验证）oneshot codex-runner timeout 不取消子进程（codex SDK TurnOptions.signal 支持 + claude q.interrupt parity + 注释 stale）→ AbortController + thread.run({signal}) + onTimeout abort。MED-2 ❌（codex 单方 — lead installed-app filesystem 实测证伪）codex-binary packaged resolver 称 pnpm layout 不匹配，但实测 installed app top-level codex-darwin-arm64/vendor 全存在（electron-builder 扁平化 pnpm）→ resolver prod 正确不修。LOW ❓ instance-pool 双构造 by-design。codex-cli/session 197 passed（+2 回归 test，MED-1 temp-revert 非空）
- [x] **Batch E — session + lifecycle + summarizer** ✅ 全收官（E1+E2 / REVIEW_83-84 / 1 HIGH + 2 MED + 3 LOW = 6 fix）
  - `src/main/session/*.ts`（manager/lifecycle-scheduler/summarizer 等）+ `src/main/store/issue-lifecycle-scheduler.ts`
  - [x] **E1 — session manager 核心**（8 文件 ~1667 LOC + 连带 manager-ingest-pipeline/session-repo/rename，commit cf0d9a0 / REVIEW_83）✅ 收口：fresh pair dr-project-e（旧 D pair closed 重 spawn）+ R1→R3 三轮。HIGH ensure() closed→active 复活架空 advanceState REVIEW_49 短路（双方独立 + lead un-skip manager-ingest.test.ts:267 实测 `expected 'active' to be 'closed'`）→ source 守卫；MED-1 archived+active session-end 幽灵 active（codex 单方）→ session-end 终止例外；MED-2 rename 漏迁 tasks/issues（codex R2 store 层互补盲点，HIGH→MED lead 可达性降级，reviewer-claude 穷举 11 处 session 引用确认 0 遗漏）→ 补 4 UPDATE。3 fix temp-revert 非空 + 60 session test + rename 2 test（node20 rebuild 临时跑后还原 Electron binding）
  - [x] **E2 — 调度器 + 总结器**（9 文件 ~1100 LOC：lifecycle-scheduler / issue-lifecycle-scheduler / summarizer/* / oneshot-llm/{index,claude-runner,build-prompt,clean-result}；skip codex-runner+race-with-timeout 已 D4 审，commit 4640bb5 / REVIEW_84）✅ 收口（**Batch E 收官**）：复用 E pair + R1→R2 两轮。异构 divergence 互补盲点：codex 1 LOW event-formatter 同毫秒逆序（listForSession id DESC + JS 稳定排序 → prompt 逆序，lead node repro）→ id tie-breaker；claude 2 LOW issue-repo listForGc 无 LIMIT（vs findHistoryOlderThan 500 不对称）→ 加 limit default 500 + summarizeNow 无 inFlight 守门（0 caller latent）→ 加守门。R2 双方交叉验证 fix 全正确共识 conclude。+5 回归 test（event-formatter 4 + listForGc LIMIT 1，LOW-1/LOW-2 temp-revert 非空）
- [ ] **Batch F — MCP spawn/send/task + teams dispatch**（fresh hand-off caller 7649071b，E pair 已 closed → 重 spawn F pair dr-project-f-20260531 / teamId e5b5abf4-6d7c-4e85-999e-46a30cb1c03a）
  - 拆 3 子批：F1（spawn.ts + spawn-link-guard.ts + _shared/default-impl-deps.ts + spawn-guards.ts + rate-limiter.ts，5 文件 ~852 LOC）/ F2（send.ts + universal-message-watcher/{enqueue,index,rate-limiter,team-event-dispatcher}.ts，5 文件 ~857 LOC）/ F3（task-{create,delete,get,helpers,list,update}.ts，6 文件 ~588 LOC）
  - reviewer pair（F 批）：reviewer-claude **599e2082** / reviewer-codex **019e7e35**（team **dr-project-f-20260531** / teamId **e5b5abf4-6d7c-4e85-999e-46a30cb1c03a**，caller **7649071b**）
  - [x] F1 spawn + guards（spawn anchors: claude 85e49430 / codex e0dcb710）✅ 收口（commit d6bda7e / REVIEW_85）：**教科书级异构 divergence 互补盲点零重叠**（codex 全押 team-transactionality / claude 全押 resource-lifecycle）。MED-1 TeamInvariantError catch 过宽吞 lead-count 失败（codex+lead grep）/ MED-2 addMember 失败只 warn 返 dishonest ok+孤儿（codex+lead grep，close 孤儿+cleanup 空 team+err）/ MED-A fanOutSlot inc 早于 try/finally leadRecord 裸抛泄漏 in-flight（claude+lead grep，guard 下移）/ MED-B recordCreatedPermissionMode 唯一未包 try/catch→孤儿活 session（claude+lead Read）/ LOW-2 rate-limiter exact-boundary off-by-one 双 limiter（codex+lead 算例）/ LOW-1 随 MED-A 消除 / INFO 注释行号→anchor。+7 回归 test 全 temp-revert 非空。MED-3 placeholder anchor 时序=已记 follow-up。
  - [x] F2 send + dispatch ✅ 收口（commit d465dd4 / REVIEW_86）：异构 divergence + 反驳轮（starvation MED）+ 双方独立 2 条。MED-1 deliver claim 后 invariant 重验在 adapter try 外抛错永卡 delivering（codex+lead grep，抽 dispatchClaimed+outer try→retryAfterFail）/ MED-2 IPC send 不看 team.archivedAt 入队 archived team dishonest ok（codex+lead Read，ipc/teams.ts Batch I scope，前置拒绝镜像 MCP send.ts）/ MED-3 process backpressure 全局 deliveredAny 致 over-cap target 被 under-cap trickle 饿死（claude+反驳轮 codex 确认扩大窗口+lead node 模拟，per-target rescue 取代全局 guard 保 REVIEW_35/56）/ LOW token-before-insert 双方独立（cheap pre-validation 前置）/ LOW PerKeyRateLimiter buckets 无 eviction（sweepEmptyBuckets+60s timer）/ LOW-2 invariant test 打不到 from-session 分支（per-sid overlay+断言 reason）/ INFO wire format 注释双锚点。+8 回归 test 全 temp-revert 非空。follow-up: deliver adapter call 无超时 / IPC teams send 无 test。
  - [x] F3 task handlers ✅ 收口（commit 157ef69 / REVIEW_87，**Batch F 收官**）：异构 divergence + 反驳轮（MED：claude R1 漏判 A→null → 反驳轮逐行 data-flow 确认+自纠 mental model）。MED task-update teamId:null 权限域切换越权——非 owner team member 把他人共享 team task 私吞成原 owner personal task（codex+反驳轮 claude，team→personal 转换要求 caller==owner）/ LOW ownerMap pre-walk 不应用 predicate 展开越权子图（双方独立）/ LOW 空 patch emit 噪声（codex）/ LOW teamId='' truthy 建畸形 task（claude，归一 null）。+5 回归 test 全 temp-revert 非空。
  - **Batch F 全收官**：F1+F2+F3 / REVIEW_85-87 / **8 MED + 8 LOW = 16 fix** + 19 回归 test + 3 反驳轮（F2 starvation / F3 MED 各 1）。共性主题：失败/异常/权限切换路径处理不彻底（F1 spawn 失败清理 / F2 claim 后异常+backpressure liveness / F3 权限域切换越权）。
- [ ] **Batch G — store repos**
  - `src/main/store/*.ts`（session-repo/* / agent-deck-team-repo/* / agent-deck-message-repo / task-repo / settings-store）
  - [x] G1 session-repo（commit 37bc0ca / REVIEW_88）✅ / G2 team-repo（commit a001989 / REVIEW_89）✅ / G3 message-repo（commit 234bbad / REVIEW_90）✅ / G4 杂项 store（commit a810d09 / REVIEW_91）✅ / **G5 settings-store（commit 2a5961a / REVIEW_92）✅ — Batch G 全收官**
  - **G5 ✅ 收口（Batch G 收官）**（commit 2a5961a / REVIEW_92，复用 G4 dormant pair）：settings-store.ts 主审（issue-repo/scheduler descope=REVIEW_70/Batch E 已审）。R1→R2 异构互补盲点：reviewer-claude 把 codex/lead 都低估为「测试盲区 LOW」的缺陷**升级为 MED 真功能 bug**。**1 MED + 1 LOW + 1 LOW/INFO + 2 INFO = 5 fix**。MED value-uplift migration（fanOut 5→10/rate 10→20）每次 boot re-fire 永久压制用户重选（lead 验证 UI 两值均合法可选）→ loose sentinel `__valueUpliftMigrationDone` gate 真一次性 + getAll() 剔除 `__` 前缀防泄漏；LOW token regen 仅 length<64 → 收紧 `/^[0-9a-f]{64}$/` canonical；LOW/INFO 版本注释 v10/v14→8.2.0/10.2.0；INFO F-R2-D set/delete 不抛→conf _write 仅 EXDEV 兜底其余 rethrow（lead 源码实证）+ sentinel 跨版本扩展边界注释。回归 test +8（14 passed，temp-revert sentinel→6 FAIL）。typecheck 双配置绿。
  - **reviewer pair（G4+G5 批用，store 收官已 shutdown）**：reviewer-claude **362712db-8c0e-41eb-8eec-3570ff65df1c** / reviewer-codex **019e7f0b-1f61-7522-ab5e-b8b52818a4c3**（team **dr-project-g4-20260531** / teamId **faf46a1b-42b6-4845-8453-d0827b55938d**，caller **29a77672**）— 已 closed，Batch H 重 spawn 新 pair
  - **Batch G（store 子系统）✅ 全收官**：G1 session-repo / G2 team-repo / G3 message-repo / G4 杂项 store / G5 settings-store（REVIEW_88-92）。下一批 Batch H（renderer core + 文案）mental model 与 store 重叠低 → hand off 边界。
- [x] **Batch H — renderer core + issue 组件（文案密集）** ✅ 全收官（H1-H3 / REVIEW_93-95 / 1 HIGH + 8 MED + 14 LOW + 5 INFO = 28 fix + 33 回归 test + 1 反驳轮 + Follow-up #15）
  - `src/renderer/App.tsx` / `stores/*` / `IssueDetail.tsx` / `IssuesPanel.tsx` / `ResolveInNewSessionDialog.tsx` / `SessionDetail.tsx` / `issue-detail-editing.ts`
  - 拆 3 子批：H1（issue 组件 5 文件）/ H2（App + session-store + event-type-guards 3 文件）/ H3（SessionDetail subsystem 10 文件）
  - [x] **H1 — issue 组件**（commit a240020 / REVIEW_93）✅ 收口：fresh pair dr-project-h-20260531（claude 23fbf1ec / codex 019e7f4c）R1→R3 三轮 + 1 反驳轮。**1 HIGH + 4 MED + 4 LOW + 2 INFO = 11 fix**。HIGH error state 二义性 save/delete 失败摧毁整表单+丢草稿+死代码（claude+反驳轮 codex+repo trim 佐证）→ 拆 loadError/opError；MED 3 处初始 IPC fetch 缺 .catch→全屏 fatal（双方独立+main.tsx 链追踪）；MED detail/list fetch 无 updatedAt guard 退回 event 版本（codex+lead）；MED mergeIssuesFromList keep-all 防剔除（codex R2+claude INFO-3）；MED same-ms mount fetch 防御+**兄弟路径转 Follow-up #15**（R3 双方共识）；4 LOW（adaptersReady/重试按钮/validateEditing/a11y）+2 INFO。+13 回归 test temp-revert 非空，1249 passed。
  - [ ] **H2 — renderer core**（App.tsx + session-store.ts + event-type-guards.ts）→ ✅ 收口（commit 2ef7854 / REVIEW_94）：复用 H pair dormant resume + R1→R2 两轮。**1 MED + 5 LOW + 1 INFO = 7 fix**。MED setPendingRequestsAll 启动快照整表替换抹 live pending → SDK 死锁（codex 单方+lead 全路径）→ merge union；MED renameSession M4 丢 fromId 7 张缓存（双方）→ moveMapKey 拆 4 merge helper；LOW pushEvent cancel `[]` 不删 key（双方）→ delete-on-empty；LOW concatEvents 排序倒挂+截最新（R2 双方+Node repro）→ sort by ts；LOW onHistorySelect seq guard + async cancelled flag；INFO 注释改正。+8 回归 test temp-revert 非空，1257 passed。
  - [ ] **H3 — SessionDetail subsystem**（index/ComposerSdk/MessagesPanel/ChangeTimeline/helpers/CliFooter/SourceBadge/composer-sdk×3）→ ✅ 收口（commit 4d7d84b / REVIEW_95，**Batch H 收官**）：复用 H pair dormant resume + R1→R2 两轮。**3 MED + 5 LOW + 2 INFO = 10 fix**。MED cancelToasts 双破损(auto-dismiss timer 绑 [recent] 被杀 + 无 key 跨会话残留，双方)；MED ComposerSdk 自读 store 对 closed 会话落 fallback 显示更宽松(claude+lead manager.list)；MED listFileChanges 无 .catch→全屏 fatal(codex)；LOW 同毫秒 file change 选旧 row(抽 helpers + id tiebreaker)/hasLoaded 重订阅吞 timer/SelectRow a11y/R2 diffError 渲染优先级不同款。+12 helpers 回归 test temp-revert 非空，1269 passed。
- [x] **Batch I — 剩余 ipc/window/utils** ✅ **descope（用户确认跳过收口）**：lead 数据勘察 → window/ 子系统已被 REVIEW_45/61 R1-R3 深审且无 churn（描述 fix 痕迹密集，05-29/30 仅 refactor/logger 触碰非逻辑）；ipc/images.ts 成熟安全代码（CHANGELOG_47 realpath TOCTOU + 双白名单 + 单 fd stat/read 齐全）；ipc/{window-app,hooks,permissions} 05-01 拆分后稳定；issue-tracker 主体 REVIEW_70 当天刚审未过期。真正「从未审 + 有料」面极薄 → 用户选「跳过 Batch I 收口 plan」（plan §Batch I「最低优先可跳」+ 已审未过期 doctrine 双重支持）

## 当前进度

- ✅ **PLAN 全收官**（2026-06-01）：Batch A-H 全部 deep review × fix 完成（REVIEW_71-95，25 子批），Batch I 用户确认 descope → 走收口。worktree ff-merge 回 main + 归档。
- 已完成：项目结构勘探、review-expiry 自检、批次设计、plan 落地、worktree 建立
- **Batch A-E ✅ 全收官**（REVIEW_71-84，详见下方各批 + checklist）
- **Batch F ✅ 全收官**（commit d6bda7e/d465dd4/157ef69 / REVIEW_85-87 / **8 MED + 8 LOW = 16 fix** + 19 回归 test + 3 反驳轮）：
  - F1 spawn+guards（REVIEW_85，4 MED + 2 LOW）：异构互补盲点零重叠（codex team-transactionality / claude resource-lifecycle）
  - F2 send+dispatch（REVIEW_86，3 MED + 3 LOW）：反驳轮收敛 starvation MED + 双方独立 2 条
  - F3 task handlers（REVIEW_87，1 MED + 3 LOW）：反驳轮 claude 自纠 mental model（权限域切换越权）
  - **reviewer pair（F 批，Batch F 收官 → dormant 可复用 / 或 shutdown）**：reviewer-claude **599e2082-a850-4146-91fe-30fb41c5497c** / reviewer-codex **019e7e35-7a32-7fe1-88cd-99fd907e4efe**（team **dr-project-f-20260531** / teamId **e5b5abf4-6d7c-4e85-999e-46a30cb1c03a**，caller **7649071b**）
- **进行中**：Batch G（store repos）— G1/G2/G3 ✅ 收官，待办 G4/G5
  - **G1 session-repo ✅ 收口**（commit 37bc0ca / REVIEW_88）：异构 divergence（双方各 1 MED 都在 rename.ts 不同点）+ 反驳轮（cli_session_id MED→INFO）+ **首次 SQLite binding rebuild 真测闭环**。MED rename toExists=true spawned_by/spawn_depth 覆盖不一致脏 spawn-chain（codex+lead SQLite 真测）/ LOW listHistory limit clamp（codex）/ LOW cwd LIKE escape（claude，同 REVIEW_61）/ LOW listAncestors dead code 删（claude）/ INFO cli_session_id UNIQUE 构造性可达正常不可达（claude MED→反驳轮 codex 降级，注释不改代码）。+1 SQLite 真测 temp-revert 非空（Electron binding 已还原）。
  - **G2 team-repo ✅ 收口（Follow-up #9 彻底闭环）**（commit a001989 / REVIEW_89）：异构强收敛（双方 0 HIGH/MED）。Follow-up #9 三失败全 root-cause = test bug 源码正确：#1 findSharedActiveTeams 断言矛盾（claude restructure t3={sB,sC} 保全覆盖）/ #2 list 同毫秒无 tie-breaker（code 加 rowid DESC，**必须 rowid 非 id** randomUUID）/ #3 partial unique test L61 create 第 3 active 同名（补 archive(t2)）。源码 LOW rejoin display_name clobber（COALESCE，与 swapLead REVIEW_56 对称）+ 2 INFO。team-repo 28 test 全过（修前 3 fail）+ 2 fix temp-revert FAIL。
  - **G3 message-repo ✅ 收口**（commit 234bbad / REVIEW_90）：**fresh pair dr-project-g3**（换 caller 9ea12275 hand-off 重 spawn）+ R1→R3 三态裁决。**R1+R2 异构互补盲点收敛为同根问题双侧对称修法**（同毫秒 `sent_at` 无 total order）。MED-1（R1 双方独立+lead sqlite3）crud.ts 4 处 list `ORDER BY sent_at DESC` 缺 tie-breaker → 插入序 oldest-first 违背「最新在前」jsdoc + 分页边界无 contract → `sent_at DESC, rowid DESC`；MED-2（R2 codex 单方+lead sqlite3）dispatch.ts findEligible/findEligibleExcludingTargets `ORDER BY sent_at ASC` 缺 tie-breaker → idx 扫描序让后插 fresh 抢先插 retry 前违背 FIFO（影响 watcher rescue + starvation 取最早）→ `sent_at ASC, rowid ASC`（EXPLAIN 证零 perf 回归）。2 INFO jsdoc/DDL drift（_deps.ts 删除工具引用 / v010 nanoid→randomUUID）+ 3 INFO ❌ by-design。reviewer-claude R3 自纠 mental model「tie-breaker 审查穷举 module 内所有 ORDER BY」+ 确认 6 个 ordering 查询全闭合。+2 回归 test temp-revert FAIL，SQLite 真测 16 passed。
  - **reviewer pair（F+G1+G2 批复用，已 closed）**：reviewer-claude **599e2082** / reviewer-codex **019e7e35**（team **dr-project-f-20260531** / teamId **e5b5abf4-6d7c-4e85-999e-46a30cb1c03a**，caller **7649071b**）
  - **reviewer pair（G3 批用，已 closed）**：reviewer-claude **b781d93e-2d81-48f7-8c04-32663a3cef89** / reviewer-codex **019e7ee6-a136-7270-a84c-25c81264fcb5**（team **dr-project-g3-20260531** / teamId **9cddd9ee-4efe-4bd8-9a9d-d408399553c9**，caller **9ea12275**）— G3 收官 shutdown
  - **G4 ✅ 收口**（commit a810d09 / REVIEW_91，fresh pair dr-project-g4-20260531）：杂项 store 9 文件 ~1225 LOC + 辅助 migration（v001/v005/v022/v025）。R1→R2 异构高度收敛（tie-breaker/LIKE escape/deleteUploadIfExists 三条全双方独立，零 HIGH 无需反驳轮）+ codex 互补补 3 条。**4 MED + 1 LOW + 2 INFO + 1 注释更正 = 8 fix**。MED-1 summary-repo:38/49/67 三处 +id DESC（含窗口，latestForSessions 被 ipc/sessions.ts 真实消费）/ MED-2 event-repo findTeamEvents/findLatestAssistantMessage/listForSessionRange（ASC 配 id ASC）补 tie-breaker（**同毫秒复发主题第 4 批**）/ MED-3 search-predicate title LIKE escape `%_\`（REVIEW_88 修 cwd 漏 title 兄弟）/ MED-4 deleteUploadIfExists resolve() 折叠 `..`（双方诚实标不可达）/ LOW（codex MED→裁 LOW）base64 decode 前 length cap / INFO×2（payload-truncate 8KB→64KB+cycle 澄清 node 实证 / event-repo limit=40 注释）/ 注释更正 v005_fts case_sensitive 与 LIKE 相反致分裂（lead sqlite3 实证，行为变更留 Follow-up #13）。回归 test repo-tiebreaker.test.ts 7（SQLite 真测 temp-revert 全 FAIL）+ search-predicate 3 escape。typecheck 双配置绿。Electron binding 已还原。
  - **reviewer pair（G4 批用）**：reviewer-claude **362712db-8c0e-41eb-8eec-3570ff65df1c** / reviewer-codex **019e7f0b-1f61-7522-ab5e-b8b52818a4c3**（team **dr-project-g4-20260531** / teamId **faf46a1b-42b6-4845-8453-d0827b55938d**，caller **29a77672**）— G4 收官可 shutdown
  - 待办子批：G5（最低）settings/issue
  - **SQLite 真测 binding rebuild 流程实证可用**：`zsh -i -l -c` 内显式 source nvm.sh + `nvm use 20.18.3` + `cd better-sqlite3 && node_modules/.bin/prebuild-install --runtime node --target 20.18.3`（npm rebuild 撞 distutils 失败走 prebuild-install）→ 跑测 → `cp /tmp/better_sqlite3.electron.bak <binding>` 还原（备份在 /tmp，size 1885024=Electron / 1884576=node20）

## Batch G 计划（store repos）

scope（~8000 LOC，需拆子批 ≤10 文件/批；issue-repo.ts 主体 REVIEW_70 刚审 descope 最低优先；task-repo/* 实现层 F3 已审 handler 调用语义，repo 实现可纳入）：
- **G1** session-repo/*（1077 LOC，core-crud/lifecycle/rename/spawn-link 等）——recovery/rename 跨表迁移高风险，排前
- **G2** agent-deck-team-repo/*（1050 LOC，member-crud/member-query/team-crud）+ **Follow-up #9 排查**（team-repo.test 3 pre-existing 失败：team CRUD unique / list 分页 / findSharedActiveTeams，需 SQLite rebuild 实测）
- **G3** agent-deck-message-repo/*（552 LOC，crud/dispatch/state-machine）——F2 已审 watcher 消费语义，repo SQL 实现纳入
- **G4** 杂项 store（event-repo/file-change-repo/summary-repo/image-uploads/payload-truncate/search-predicate/message-delivery-state/db/migrations）——按内聚拆
- **G5（最低）** settings-store / issue-repo（REVIEW_70 刚审，时间不够可跳）
- **SQLite 真测**：G 批大量碰 store，必用 plan §当前进度末 binding 备份/还原流程（nvm use 20.18.3 + npm rebuild → 跑测 → 还原 Electron ABI130 binding）
  - A1 hand-off orchestration（commit 826af22 / REVIEW_71）：HIGH adoptTeammates+archiveCaller:false guard / MED processSwappedTeam list-get 半提交 / INFO 文档漂移 + 2 回归 test
  - A2 worktree handlers（commit 08db5e8 / REVIEW_72）：MED enter show-toplevel→git-common-dir（双方实测）/ MED exit 未合并 commit 先删 worktree / LOW frontmatter base_commit verify + 4 回归 test
- **Batch B1 ✅ 收口**（commit ba0b609 / REVIEW_73）：archive_plan 事务核心 facade+precheck+ff-merge。MED post-ff-merge late phase 跳过 baton cleanup（双方独立）/ LOW 8c 缺 plan_id/worktree_path 复查（codex HIGH→claude 反驳降 LOW）/ MED 8b generic hint→reset hint + 3 回归 test
- **Batch B2 ✅ 收口**（commit 7d82896 / REVIEW_74）：archive-plan helper 层 5 文件。HIGH isPostCommitArchiveError regex `[a-z-]+` 漏判含大写 post-commit phase（archive-rev-parse-HEAD/git-branch-D）→ 不跑 baton cleanup 致 teammate 孤儿 dormant（claude HIGH + codex MED 双方独立 + lead node 三重确认；**正是 B1 late-phase 修法漏覆盖的 2/3 phase**，B1 test 只测唯一全小写 git-worktree-remove 故漏网）→ startsWith 遍历 Set / MED INDEX 单飞锁 set-after-await ≥3 并发退化丢行 + finally 无 identity check（双方独立 + lead /tmp harness 实测 lost=B）→ set-before-await 真链式 + identity-check delete / INFO rename display new->old 反向（codex + lead git 实测）。+15 回归 test（3 fix 全 temp-revert 非空验证）
- **进行中**：Batch C（adapters claude-code sdk-bridge — recovery/并发/lifecycle），拆 4 子批 C1-C4
  - **C1 ✅ 收口**（commit d620ac4 / REVIEW_75）：HIGH createSession 失败落孤儿 tempKey DB row（codex + lead emit→ingest→dedupOrClaim 全链 trace；catch 补 sessionRepo.delete(tempKey)）/ MED orchestrator prepare→finalize 无 try/catch resolver 抛错漏清（claude + diff a21f258~1 非回归）/ MED claimAsSdk(realId) 自然 end 漏释放 CLI sid（codex）/ 5 INFO + 5 回归 test
  - **C2 ✅ 收口**（commit 28b0887 / REVIEW_76）：⚠️ 异构 divergence（codex 2 MED / claude 0 MED→反驳轮 ✅ 同意 + 补黑名单不对称确证）。MED-1 recovery 失败前 user emit 把 closed 复活成 active 不回滚 dead-active 幽灵（wasClosed + markClosed 回滚）/ MED-2 listEventsFn 在 try 外破坏「永不抛错」契约 / INFO 注释漂移 + 2 INFO by-design + 5 回归 test
  - **C3 ✅ 收口**（commit 82b951d / REVIEW_77）：hand-off 后新 caller 4a53af3a + fresh pair（旧 closed 重 spawn dr-project-c3）。**双方独立收敛 clean 0 HIGH/0 MED**，4 finding 全 INFO/LOW comment-only。3 INFO fix（CHANGELOG_61 占位符回填双方独立 / race guard realSessionId 三档链注释重写 codex / C1 cliSid release 注释精确化 claude）+ 1 LOW ❌ 不改代码（刻意设计正确，lead 更正 reviewer 黑名单 source 事实错误）。C1/C2 已修点 fresh pair 复查全部正确
  - **C4 ✅ 收口（Batch C 收官）**（commit 28cdd3b / REVIEW_78）：复用 C3 pair。异构 divergence（codex 2 MED / claude 1 MED 注释 + 显式反驳 codex MED-2）。MED-1 ✅ ExitPlanMode 热切档 cache desync + 失败只 log（codex + lead 验证）→ cache 同步 + 回滚 + error。LOW ✅ cancelPendingAndEmit 不 resolve（codex MED → claude 反驳 → lead 裁 LOW 仍防御性 fix）。INFO ✅ 双方独立 realSessionId 注释漂移 5 处。+5 回归 test
- **Batch C 收官**：C1-C4 全 27 文件，累计 8 bug fix（C1 3 / C2 2 / C3 0 / C4 2）+ C3/C4 注释精确化，系统覆盖会话创建/recovery/流消费/翻译/权限/重启全链路
- **Batch D ✅ 全收官**（codex-cli adapter 全量 28 文件，4 子批 D1-D4 / REVIEW_79-82）：
  - **D1 ✅**（commit 58e214e / REVIEW_79）：MED-1 create-session-impl.ts:151 internal.threadId 初值用 cli-sid 修 reverse-rename 后误触 case-3 fork（claude 单方+temp-revert）+ MED-2 rollback/thread-options-builder 零 test（双方独立）+ 4 INFO + 10 test
  - **D2 ✅**（commit 68baae9 / REVIEW_80）：MED restart-controller.ts:129 forward setCodexSandbox 在 try 外 throw 静默死态（双方独立 + claude 补回滚掩盖 err + claude parity follow-up）+ LOW translate loader-filter 过宽（双方独立）+ 4 test
  - **D3 ✅**（commit 18bfc50 / REVIEW_81）：MED-1 recover-and-send closed-revival 无 markClosed 回滚 dead-active 幽灵（C2 claude 对称缺口；双方独立 + lead trace）+ MED-2 jsonl-fallback emit 顺序时间线矛盾（codex 单方 + lead parity）+ 5 test
  - **D4 ✅**（commit d510cb3 / REVIEW_82，**收官**）：MED-1 oneshot codex-runner timeout 不取消子进程（codex 单方 + lead SDK signal/claude parity 验证）+ MED-2 codex-binary pnpm layout **lead installed-app filesystem 实测证伪**（异构对抗拦误报）+ LOW instance-pool 双构造 by-design + 2 test
- **累计**：25 bug fix（A1/A2/B1/B2/C1/C2/C4/D1×2/D2/D3×2/D4）+ 6 注释 fix（C3/C4）+ D 批 10 INFO + 60 回归 test，typecheck 双配置全绿；D4 跑 codex-cli/session 197 passed
- **Batch E ✅ 全收官**（session/lifecycle/summarizer，E1+E2 / REVIEW_83-84 / **6 bug fix**：1 HIGH + 2 MED + 3 LOW）：
  - **E1 ✅**（commit cf0d9a0 / REVIEW_83）：fresh pair dr-project-e（旧 D pair closed 重 spawn）+ R1→R3 三轮。HIGH ensure() closed→active 复活架空 advanceState REVIEW_49 短路（双方独立 + lead un-skip manager-ingest.test.ts:267 实测 `expected 'active' to be 'closed'`）→ source+archivedAt 三守卫；MED-1 archived+active session-end 幽灵 active（codex 单方）→ session-end 终止例外；MED-2 rename 漏迁 tasks/issues/issue_appendices（codex R2 store 层互补盲点，HIGH→MED lead 可达性降级 — 两 live caller 都 tempKey→realId spawn bootstrap，task/issue 不挂 tempKey；reviewer-claude 穷举 11 处 session 引用确认 0 遗漏）→ 补 4 UPDATE。+10 回归 test
  - **E2 ✅**（commit 4640bb5 / REVIEW_84，**Batch E 收官**）：复用 E pair + R1→R2 两轮。异构 divergence 互补盲点：codex 1 LOW（event-formatter 同毫秒逆序——listForSession id DESC + JS 稳定排序 → prompt 逆序，lead node repro，tie-breaker fix）/ claude 2 LOW（issue-repo listForGc 无 LIMIT vs findHistoryOlderThan 500 不对称 → 加 limit default 500；summarizeNow 无 inFlight 守门 0 caller latent → 加守门）。+5 回归 test（event-formatter 4 + issue-repo LIMIT 1）
- **reviewer pair（E 批用，Batch E 收官 → dormant 保活可复用 / 或 shutdown）**：reviewer-claude **b5dec7dc-bf0d-4f15-83e9-6fa954742de4** / reviewer-codex **019e7d8e-6c23-7b60-9a8b-1738e3e6bc84**（team **dr-project-e-20260531** / teamId **4ff26dbd-da08-490e-a3ef-95a69b4b35b4**，caller **b5fd153f**）。**Batch E 已收官**：同 caller（b5fd153f）续作 Batch F 可复用（send Round 1 全量 prompt 新 scope，dormant 自动 resume）；hand off 换 caller 则按 §跨会话救火 重 spawn 新 pair（dr-project-f）+ 旧 E pair shutdown。
- **reviewer pair（D 批用，已收官）**：reviewer-claude c12a42ce / reviewer-codex 019e7d1f（team dr-project-d-20260531，caller 18d3e9ba）— 已 closed
- **reviewer pair（C 批用，已 closed 不可复用）**：C1-C2 claude 2fc6617f / codex 019e7c9d（dr-project-c）；C3-C4 claude 14fced01 / codex 019e7ced（dr-project-c3）— 均 closed
- **test 基建**：worktree 无 node_modules → `ln -sfn /Users/apple/Repository/personal/agent-deck/node_modules <worktree>/node_modules`（git ignored），再 `node_modules/.bin/vitest run <files>` 跑测；typecheck 走 `pnpm typecheck`。**SQLite 真测（issue-repo / team-repo / session-repo）**：worktree node_modules 软链到主仓库 → better-sqlite3 binding 是 Electron ABI 130，vitest 默认 node（v24 ABI 137）跑会 skip。真要跑：备份 `cp node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node /tmp/bak` → `nvm use 20.18.3 && npm rebuild better-sqlite3` → 跑测 → **务必还原** `cp /tmp/bak <binding>`（否则 dev/app 起不来，见 CLAUDE.md §打包踩坑）。E2 已用此法验 issue-repo LIMIT test。

## Follow-up 汇总（留用户回来决策，勿在 review 流程中自动改）

1. **[MED 已验证] A1 partial adopt 失败 team teammate 泄漏**（REVIEW_71）— baton-cleanup 需 team-scoped shutdown vs non-first swap failure 提升 fatal，design 取舍。
2. **[LOW] A1 同 callerSessionId handler 内 sessionRepo.get 重复反查 2 次**（REVIEW_71）。
3. **[LOW] A1 显式 args.cwd 无 existsSync 预检**（REVIEW_71）。
4. **[LOW] A2 enter marker 写失败不回滚已建 worktree**（REVIEW_72）+ 修正 jsdoc「git 操作不可逆」表述。
5. **[LOW] A2 exit realpath fallback 尾斜杠归一化**（REVIEW_72）+ 对齐 schema worktreePath describe 尾斜杠。
6. **[LOW] B1 worktree remove 不带 --force**（REVIEW_73）— precheck→step14a 窗口 worktree 被写脏时失败。
7. **[LOW] B1 cwd-resolver 重复**（REVIEW_73）— archive-plan.ts vs hand-off-session/cwd-resolver.ts 抽 `_shared/caller-cwd-resolver.ts`。
8. **[INFO] B2 INDEX 概要列 fallback 到 plan_id 恒显示 planId**（REVIEW_74）— `impl-archive-fs.ts:148` plan frontmatter 无 description 字段 → 概要列无实际价值。可考虑读 plan §总目标首行 / frontmatter 加 title 字段（功能增强非 bug）。
9. **[INFO 跨批] agent-deck-team-repo.test.ts 3 个 pre-existing 失败**（REVIEW_83/84）— team CRUD unique / list 分页 / findSharedActiveTeams；baseline（无本改）即 `3 failed`，与 Batch E 无关。疑似 better-sqlite3 ABI 临时 rebuild 环境差异 or 真 pre-existing bug，留 Batch G（store repos）专项排查。
10. **[INFO 测试盲区] hand-off.test.ts:165 claude oneshot timeout 占位断言**（REVIEW_84，reviewer-codex E2）— `expect(true).toBe(true)` 假覆盖，建议给 runClaudeOneshot/raceWithTimeout 加 fake-timer 单测（async iterable 永不 yield，断言 reject message + interrupt spy 被调）。非 bug，测试网补强。
11. **[LOW 可选优化] issue GC 续删节奏**（REVIEW_84，reviewer-claude E2）— 6h tick × 500 对「用户调短 retention 想快速清积压」偏慢；GC 非紧急可不动，若需可加首次缩短 tick。
12. **[INFO 测试盲区] findEligibleExcludingTargets 空数组 fallback / NOT IN 排除 仅集成层覆盖**（REVIEW_90，reviewer-claude G3 R2）— G3 R2 回归 test 已补 FIFO + 非空 excludeTargets 路径，但「空数组 fallback（不拼 NOT IN ()）/ NOT IN 正确排除」两契约仍只集成层（universal-message-watcher stateful stub）间接覆盖，repo 层无直接 unit test 锁。R1 已 sqlite3 真测三契约正确（含 `NOT IN ()` 确为 syntax error 证 length>0 guard 必要），当前实现正确，补 repo unit test 仅提升回归防护，非必修。
13. **[MED 已验证 行为变更] FTS case_sensitivity 与 title LIKE 分裂**（REVIEW_91，reviewer-codex G4）— `v005_fts.sql` `case_sensitive 1` 让 events_fts/summaries_fts MATCH 大小写敏感，与 title LIKE（SQLite 默认 ASCII 大小写不敏感）分裂：搜 "Foo" 命中含 "foo" 标题但漏含 "foo" 事件正文。本 review 仅更正注释如实说明（未改行为，超「不改 breaking change」授权）。对齐唯有 FTS `case_sensitive 0` + rebuild + changelog 公告（搜索语义变更）。lead sqlite3 + 双 reviewer R2 实证确认无绕开 rebuild 的轻量方案（COLLATE BINARY 反向把 title 改敏感=UX 倒退）。留用户决策方向（大小写敏感 vs 不敏感作为历史搜索默认）。
14. **[INFO 公式前提备忘] base64 length cap 假设无换行 base64**（REVIEW_91，reviewer-claude G4 R2）— `image-uploads.ts:75` 前置 cap `ceil(MAX*4/3)+4` 隐含假设 renderer 传无换行 base64。若未来 renderer 改 MIME-formatted（76 列 `\n`）base64，满额图长 28329949 > cap 会误拒。当前 browser `btoa`/`FileReader.readAsDataURL` 均不产换行 → 不可达，仅公式前提备忘。
15. **[MED 已验证] issue same-ms updatedAt tie 的 store-sync / list-merge 两条兄弟路径未闭合**（REVIEW_93，reviewer-codex H1 R3）— `Date.now()` ms 非单调，同毫秒 create/update/append 可同 updatedAt。H1 R2 仅修 mount fetch 路径（equal 只补 appendices 不覆 content）；残留两条同根路径：(a) IssueDetail.tsx:146 store-sync effect `===updatedAt` early-return → 同毫秒不同内容 event 不 rebase 到 detail；(b) issues-store.ts:81 mergeIssuesFromList `>` 保本地 → equal 时旧 list 快照覆盖 event 版本。**双方 R3 共识转 Follow-up**：可达性需「两并发写者同毫秒写同一 issue」近乎不可达 + 非数据丢失（DB 正确）+ 下个 event/refetch 自愈 = MED-leaning-LOW 瞬时 staleness；根治 = repo 层加单调 revision（issue-repo REVIEW_70 scope + shared schema = 授权边界外）；renderer seq band-aid 触 HIGH-A/B/Round2/3 最高风险 editing 逻辑不成比例。IssueDetail.tsx mount fetch 注释已显式 acknowledge 两路径（不静默 drop）。留用户决策是否 repo 层根治。

## 下一会话第一步（cold start）

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/deep-review-project-20260531.md` 读全
2. `EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/deep-review-project-20260531")`
3. `git -C <worktree> log --oneline -10` 确认 HEAD（应见 2a5961a G5 / a810d09 G4 / 234bbad G3 / a001989 G2 / 37bc0ca G1 / 157ef69 F3）
4. **test 基建**：worktree node_modules 已软链主仓库（若缺 `ln -sfn /Users/apple/Repository/personal/agent-deck/node_modules <worktree>/node_modules`）。普通 test `cd <worktree> && node_modules/.bin/vitest run <files>`；typecheck `zsh -i -l -c "pnpm typecheck"`。**SQLite 真测**（Batch H renderer 通常不碰 store，多数无需）走 §当前进度 Batch G 节末「binding rebuild 流程」：`zsh -i -l -c` 内 source nvm.sh + `nvm use 20.18.3` + prebuild-install --target 20.18.3 → 跑测 → **务必** `cp /tmp/better_sqlite3.electron.bak <binding>` 还原。⚠️ 备份可能跨会话丢失，先 `ls -la <binding>`（1885024=Electron / 1884576=node20）确认
5. **reviewer pair 复用判断**：G4+G5 pair（claude **362712db** / codex **019e7f0b** / team **dr-project-g4-20260531**）store 收官后可 shutdown（若未 shutdown 仍 dormant，但 H 是 renderer，mental model 与 store 重叠极低 → 重 spawn 无损失）。本次 hand off 换 caller → 撞 no-shared-team，按应用约定 §跨会话救火 **重 spawn 新 pair**（teamName 自定如 dr-project-h）+ 旧 pair shutdown（如还活）
6. 找 checklist 第一个未打勾批次（**Batch H — renderer core + issue 组件，文案密集**）→ 走 deep-review SKILL 流程（spawn/send → review → 反驳轮 → 三态裁决 → fix → commit + REVIEW_X.md **X 从 93 起** + 打勾）。H scope：`src/renderer/App.tsx` / `stores/*` / `IssueDetail.tsx` / `IssuesPanel.tsx` / `ResolveInNewSessionDialog.tsx` / `SessionDetail.tsx` / `issue-detail-editing.ts`（按内聚拆子批 ≤10 文件；renderer 文件多，注意拆批）。**focus 偏移**：renderer 是 React/TS（非 store SQL），focus 转向 state 管理 race / useEffect 依赖 / stale closure / 文案措辞（issue 组件文案密集）/ XSS（dangerouslySetInnerHTML）/ key collision / 可访问性。**注**：issue 组件含近期改动 + 文案密集是 H 重点
7. Batch H（renderer+文案）→ I（剩余 ipc/window/utils 可跳，REVIEW_70 issue-tracker 主体刚审）→ plan 收口
8. 进度 / 决策变更随时同步本 plan §当前进度

> **Batch F + G（G1-G5）✅ 全收官**（F1-F3 REVIEW_85-87 / G1-G5 REVIEW_88-92，store 子系统全清，含 Follow-up #9 闭环 + 同毫秒 tie-breaker 四连 G2/G3/G4/E2 + value-migration re-fire MED）。本次 hand off 在 **Batch G↔H 边界**（store 持久层 → renderer UI，mental model 重叠极低，换 caller 重 spawn 无损失，且 focus 从 SQL/SQLite 转向 React state/文案）。累计本 plan A-G 已 commit 22 批 review。

## 已知踩坑

- **worktree 路径前缀**：进 worktree 后所有 Edit/Read/Grep/Bash 绝对路径必须含 `.claude/worktrees/deep-review-project-20260531/`；reviewer scope paths 同理。进 worktree 先 `Bash: pwd` 自检
- **EnterWorktree stale base bug**：用 `EnterWorktree(path:)` 不用 `name:`；worktree 已用 `git worktree add -b`（隐式 HEAD base）创建
- **REVIEW 编号**：worktree 内最大 REVIEW_92（A1-G5，store 子系统全收官）；新 REVIEW 从 93 起。主分支基线 REVIEW_70 / CHANGELOG_189
- **reviewer-codex 失败**：严禁同源双 claude；按 SKILL §失败兜底 走「等恢复 → 合规兜底外部 CLI → 降级单方非 HIGH」
- **跨会话第一次读 plan / 代码资产**：用 `Bash: cat` 不用 `Read`（CLI 跨会话 cached Read 陷阱）
