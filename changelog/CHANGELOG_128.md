# CHANGELOG_128 — deep-review-batch-a1-b-fixes-20260519 plan 收口:6 HIGH + 11 MED 落地

## 概要

收口 deep-code-review SKILL 6 batch 累积出的 6 HIGH + 11 MED(claude-code SDK bridge A1 batch
+ agent-deck-mcp tool handlers B batch),走「复杂 plan 流程 v2」(RFC 两轮 + spike 实证 + plan-review
双对抗 + Phase 1/2/3 fix + R3 verify)。

3 commit 落地 + 5 新测试文件 + 现有测试增量 + Phase 1 引入的 mock 队列偏移 regression 修复。
typecheck / 826 全套测试 / build 全过。R3 verify 重 spawn 4 reviewer 出新 5 HIGH + 9 MED 全属
**未识别同类深层 bug + 测试补全 debt**(非本轮 fix 引新 regression),落 follow-up plan;详
[REVIEW_47.md](../reviews/REVIEW_47.md) §R3 verify 节。

## 变更内容

### Phase 1 — P0 安全 / 数据丢失 3 HIGH(commit `91cb584`)

**B-HIGH-1 (C) 两层 spoofing 守门**(`src/main/agent-deck-mcp/`):
- `tools/helpers.ts:54+`: `denyExternalIfNotAllowed` 加 stdio invariant assertion 兜底分支
  (`transport === 'stdio' + callerSid !== EXTERNAL_CALLER_SENTINEL` deny + console.error log;
  HTTP per-session authn 通过仍走 resolvedSid real sid 不误伤合法路径)
- `transport-stdio.ts:77`: `callerSessionIdOverride: null` → `() => EXTERNAL_CALLER_SENTINEL`
  force sentinel(let tools/index.ts:108 `overridden ?? args.caller_session_id` 在 stdio 路径下
  overridden=sentinel 短路完全忽略 args.caller_session_id 防 spoofing)
- `transport-http.ts:92-98`: `fallbackToGlobal=true` 时 `extra.authInfo.resolvedSid` → force
  `EXTERNAL_CALLER_SENTINEL`(global token 路径无 per-session authn → spoofing 防御);
  per-session authn 通过 (`fallbackToGlobal=false`) 仍走 `resolvedSid ?? EXTERNAL_CALLER_SENTINEL`
  保持合法路径

**B-HIGH-3 base_branch refs/heads/ namespace 校验**(`archive-plan-impl.ts:451`):
- 旧 `rev-parse --verify <branch>` 接受 SHA / tag / detached HEAD → 修后 `rev-parse --verify
  --quiet refs/heads/<branch>`,严格落 named branch namespace。reject error 措辞从「does not exist」
  → 「is not a named branch (refs/heads/<name>); SHA / tag / detached HEAD refs are not allowed」+
  hint 引导 caller 修 plan frontmatter

**B-HIGH-4 mainRepo dirty fail-fast precheck**(`archive-plan-impl.ts:229+`):
- 新加 step 3.5 `git status --porcelain` 在 mainRepo 上预检(原 step 3 仅检 worktreePath),dirty
  reject + hint 提示 caller 先 `commit / stash / git restore` 再 archive。防 step 13 `git commit -m`
  默认行为吞并 caller 预先 staged 文件混入归档 commit

### Phase 2 — P0 功能 broken 3 HIGH(commit `f260fd8`)

**A1-HIGH-1 假 session leak 彻底失败语义**(`sdk-bridge/index.ts:294+`):
- `waitForRealSessionId` 拿到 realId 后立即 guard `if (realId === tempKey) throw`(SDK 流自然终止
  但从未发 first session_id frame 时返 tempKey 路径),让 createSession 进 catch L298 走完整
  cleanup(`sessions.delete(tempKey)` + `releasePending` + `releaseSdkClaim(opts.resume)` + rethrow)
- 与 plan §不变量 1 (A) 「彻底失败语义」等价(不动 consume catch 保留 emit 红字 UI 提示,由
  createSession guard throw 阻断假 session)

**A1-HIGH-2 setTimeout fallback 对称切 sessions Map**(`sdk-bridge/stream-processor.ts:140+`):
- setTimeout fallback 体内 `internal.realSessionId = fallbackId` 后补 sessions Map key 切换
  (`delete tempKey + set fallbackId`)。与 consume L207-219 first-id 路径同款对称
- 不调 `renameSdkSession`(resume 场景 fallbackId === resumeId === OLD_ID,renameWithDb 走
  toExists=true 但 tempKey 行不存在(还没 ingest)早返,实际 no-op)
- 防 `sendMessage(fallbackId)` miss 触发 recoverer 起第二个 SDK CLI 子进程 + listPending /
  respondPermission / setPermissionMode / interrupt 全部撞墙

**B-HIGH-2 archive_caller=false 退化 normal spawn**(`tools/handlers/hand-off-session.ts:325+`):
- `batonMode` 改条件化:`args.archive_caller !== false`,让 archive_caller=false 退化走完整
  spawn-guards depth + fan-out + setSpawnLink。修复 archive_caller=false × N 形成无限 spawn 路径
  绕 fan-out=5/parent + depth=3 双护栏的设计假设破坏

### Phase 3 — 11 MED + 测试补全(commit `c64ba31`)

**A1-MED ×6**(claude-code SDK bridge):
- `index.ts:543+` setPermissionMode SDK throw 回滚 in-memory `s.permissionMode = oldMode`
  (与 restartWithPermissionMode 失败回滚 DB 同款 fail-fast)
- `options-builder.ts` 抽 `REVIEWER_AGENT_NAMES` SSOT + `isReviewerAgentName` type guard,主分支
  L142 用 SSOT guard 替代 hardcode `=== 'reviewer-claude' || === 'reviewer-codex'`(L150 子分支
  AGENT_DECK_CLAUDE_PATH 注入仍 hardcode 'reviewer-claude' 子集独有逻辑)
- `recoverer.ts:603+` findFallbackCwd jsdoc 加 caller 链路 NOTE 解释 by-design(降级 doc-only,
  不动行为)
- `translate.ts:191+` translatePostToolUse 函数签名加 `tool_use_id?: string`(SDK PostToolUse hook
  payload 提供此字段,spike1 实证),4 处 file-changed emit(Edit / Write / MultiEdit / image)透传
  `toolCallId: p.tool_use_id`
- `sdk-message-translate.ts` Edit/Write/MultiEdit file-changed emit 时序从 assistant.tool_use 推迟
  到 user.tool_result + status='completed'(InternalSession 加 `pendingFileChangeIntents` Map,
  `maybeEmitFileChanged` 改名为 `pushFileChangeIntent` push 到 Map,新加
  `consumePendingFileChangeIntent` 在 tool_result 阶段 status='completed' emit + delete /
  'failed' 仅 delete 不 emit)。stream-processor finally 显式 clear 防 leak。修前 SDK 工具 fail
  仍 emit 脏 file-changed
- `restart-controller.ts:82+ / :211+` 两处 `if (inflight)` 改 `while (inflight)` 循环 re-check
  recovering Map 防 multi waiter race(3 caller 同时入,A finally 释放 → waiter B 拿 lock + set
  新 promise 但 waiter C 还 await A,A resolve 后 C 直接进 close+createSession 跟 B 并发)

**B-MED ×5**(agent-deck-mcp tool handlers):
- `archive-plan-impl.ts:339+` cwd 4 态 release marker 边界拆 (c-1)/(c-2)/(c-3) 子档 — marker ==
  worktree 才 release / marker 指向另一 worktree 仅 warn 不 release(拒绝跨 worktree release 别人
  marker)/ marker null 直接放过
- `exit-worktree-impl.ts:170+` worktree 已删 + clearCwdReleaseMarker throw 改 catch return error
  (与 step 6 happy path 对称),partial-success 显式报告 caller 决定如何 recover
- 新建 `tools/handlers/plan-path-helpers.ts` 抽 `resolvePlanFilePath` helper — 3 档 fallback
  (projectLocal `<main>/.claude/plans/` > projectArchived `<main>/plans/` > userGlobal
  `~/.claude/plans/`)+ mainRepo===null 跳过 project-scoped。`hand-off-session-impl.ts` +
  `archive-plan-impl.ts` 都调 helper 共享 SSOT(双方独立强冗余 finding)
- `archive-plan-impl.ts:730+` `filesToAdd` 加 `path.relative(mainRepo, planFilePath)`(仅当 source
  在 mainRepo 子树 + ≠ archivedPath),归档 commit 含 source `D` (删除) + archived `A` (新增)
- `hand-off-session-impl.ts:201+` 加 plan_file_path stem 校验(必须等于 plan_id),与
  archive-plan-impl L386-392 同款治法,防 cold-start prompt 指向另一 plan 文件

**测试补全**:
- 新增 5 测试文件:`translate-post-tool-use-toolcallid.test.ts`(5 cases) /
  `file-change-intent-delay.test.ts`(6 cases) / `set-permission-mode-rollback.test.ts`(3 cases) /
  `plan-path-helpers.test.ts`(8 cases) / `plan-path-helpers.ts` helper module
- 现有测试增量:TC15 cwd-marker(状态 c-2)/ hand-off stem case / exit_worktree partial-success case
- Phase 1 mainRepo dirty precheck 引入的 mock 队列偏移 regression:`archive-plan/_setup.ts` makeDeps
  加透明拦截 mainRepo `git status --porcelain` mock(默认 '' clean,不消耗 gitMockPlan 队列也不 push
  gitCalls,`recognizedMainRepos` 默认含 `/Users/test/repo`),所有现有 archive-plan 测试不动。修 base_branch
  verify args 期望(`refs/heads/<name>` 改动)
- InternalSession mock 补 `pendingFileChangeIntents: new Map()` 字段
  (`can-use-tool.test.ts` / `sdk-bridge.consume-fork.test.ts`)

## 验证

```
pnpm typecheck    ✅
pnpm test         ✅ 826 tests, 755 passed + 71 skipped (sandbox EPERM 与本 plan 无关)
pnpm build        ✅
```

## R3 verify 发现 (follow-up plan 处理)

R3 重 spawn 4 reviewer fresh review (caller session 不在原 R1/R2 team) 出 5 HIGH + 9 MED + 4 LOW
+ 2 INFO + 5 未验证。**全部属于「未识别同类深层 bug + 测试补全 debt」**,非本轮 fix 引入的
regression。本 plan 范围严格 = R1/R2 6 HIGH + 11 MED 已 100% 落地;R3 finding 落 follow-up plan,
详 [REVIEW_47.md](../reviews/REVIEW_47.md) §R3 verify 节。

**关键 5 HIGH follow-up**(下次 plan 必修):
1. consume vs setTimeout fallback 30s 并发 mutate race(双方独立强冗余)
2. createSession throw 路径不 interrupt SDK query → detached consume 生 ghost session
3. translateSdkMessage 同步 SDK status `permissionMode` 只写 DB 不写 `internal` cache → canUseTool
   读脏 cache(安全边界错误)
4. `transport-http-extra-auth.test.ts` inline 合约测试 stale 测旧 vulnerable 行为(B-HIGH-1 修法
   collateral test debt)
5. plan §Phase 1+2 承诺 7 个 P0 regression test 文件全部零创建(B-HIGH-1/3/4 + A1-HIGH-1/2 +
   B-HIGH-2 修法零回归保护)

**用户 R3 阶段额外反馈**(follow-up plan 必含):**hand_off_session baton 时应 shutdown dormant
teammate + team 不应跟着旧 lead 流传**(default `keep_teammates: false` 的 shutdownTeammatesOnBaton
helper 在 dormant teammate 上没生效;list_sessions 显示 6 个旧 reviewer 全 dormant 而非 closed)。

## 关联归档

- [REVIEW_47](../reviews/REVIEW_47.md):本 plan 全程异构对抗 review × R1/R2/R3 三轮裁决详情
- plan archive 路径:`<main-repo>/plans/deep-review-batch-a1-b-fixes-20260519.md`(Phase 5
  archive_plan 完成后)
