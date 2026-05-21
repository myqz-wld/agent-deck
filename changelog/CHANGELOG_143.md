# CHANGELOG_143 — restart-controller jsonl 预检 + helper 共享 fallback 路径

## 概要

`restart-controller-jsonl-precheck-20260521` plan 收口 — 修 ExitPlanMode bypass / 切 sandbox 档撞 "No conversation found with session ID: <sid>" 错误(CHANGELOG_142 末尾遗留 SDK 流中断错误本 plan 闭环)。

**根因**:`restart-controller.ts:182/331` 两条冷重启路径直接调 `createSession({resume: currentSid})` 没做 jsonl 预检,与 `recoverer.ts:378 recoverAndSend` 路径不对称 — jsonl 不在时 CLI hard fail "No conversation found",catch 回滚 DB + emit error message,用户体验糟(重发后 Claude 失 plan 上下文,cold start 重新理解)。

**修法**:抽 `jsonl-fallback.ts` helper(plan §D2 选项 C 决策)让 `restartWithPermissionMode` / `restartWithClaudeCodeSandbox` / `recoverer.recoverAndSend` 三条路径共享 jsonl-missing fallback —— 预检 + `prependHistorySummary` 续历史摘要 + `createSession with resumeMode='fresh-cli-reuse-app'` 复用 applicationSid + emit fallback info message(按 §D4 三轴矩阵 6 文案)+ emit role='user' message(含 attachments 透传)。

详 [`plans/restart-controller-jsonl-precheck-20260521.md`](../plans/restart-controller-jsonl-precheck-20260521.md)(plan-review 7 轮收口 0 HIGH 0 真 MED 后实施)。

## 变更内容

### 新增 / 抽离

- `sdk-bridge/jsonl-fallback.ts`(新建,~290 LOC)— `maybeJsonlFallback(ctx, opts)` helper + 4 个 interface(`JsonlFallbackCtx` / `JsonlFallbackOpts` discriminated union recover/restart + `JsonlFallbackResult` + `JsonlFallbackCreateOpts`)
- `sdk-bridge/recoverer-messages.ts` 加 2 个 builder(`buildRestartJsonlMissingSummaryUsedText` + `buildRestartJsonlMissingSummarySkippedText`),覆盖 restart 路径 jsonl missing × summary used/skipped 双文案(§D4 文案矩阵 6 case 完整覆盖)

### sdk-bridge 改动

- `sdk-bridge/index.ts` createSession finalize 链加 `resumeMode` guard:`if (opts.resumeMode !== 'fresh-cli-reuse-app') finalizeSessionStart(...)` — fresh fallback 路径完全跳过 finalizeSessionStart(不 emit session-start / 不 setClaudeCodeSandbox / 不 setModel / 不 setExtraAllowWrite / 不补 emit 首条 user message),避免撞唯一索引(§不变量 9)
- `sdk-bridge/index.ts` 加 `listEventsForSession(sid)` protected method(同 `resumeJsonlExists / cwdExists / summariseForHandOff` wrapper 模式),与 `RestartController` / `SessionRecoverer` ctor 共享同一 closure 注入
- `sdk-bridge/restart-controller.ts` `RestartCreateOpts` 加 `resumeMode?: 'resume-cli' \| 'fresh-cli-reuse-app'` 字段;`RestartCtx` 加 `jsonlExistsThunk + summariseFn + listEventsFn` 3 字段(Step 3b + 3c)
- `sdk-bridge/restart-controller.ts` `restartWithPermissionMode` + `restartWithClaudeCodeSandbox` 在 line 182 / 331 createSession 前调 `maybeJsonlFallback`(`emitContext='restart'` + `restartLabel='权限模式 ${mode}'` / `'OS 沙盒 ${sandbox}'`);fellBack=true 直接 return currentSid 不重复 createSession(Step 3d + 3e)
- `sdk-bridge/recoverer.ts` line 378-491 inline fallback 实施(~113 LOC,prependHistorySummary + 4 文案 emit + createThunk fresh-cli-reuse-app + return)抽到 helper(净 -100 LOC + 共享);`SessionRecoverer` ctor 加第 6 字段 `listEventsFn`,line 395 inline closure 改 `this.listEventsFn`(Step 3f + 3g)
- `sdk-bridge/__tests__/restart-controller-fork-rename.test.ts` 测试 stub 补 3 字段(`jsonlExistsThunk: () => true` + `summariseFn: async () => null` + `listEventsFn: () => []`)

### 测试新增

- `__tests__/jsonl-fallback.test.ts`(20 测试)— T2/T4/T7/T8/T9/T10 helper 内部行为(jsonl 预检 OR 短路 / cliSessionId 维度找 jsonl / 摘要双态 / 6 文案矩阵 / createSession opts 字段 / attachments 三 sub-case T9a/b/c / createSession 抛错 helper rethrow 不 emit)
- `__tests__/restart-controller-jsonl-precheck.test.ts`(4 测试)— T1/T3 caller 集成路径(jsonl 在 → fellBack=false 走原 resume + opts.resumeCliSid 正确;jsonl 缺失 + createSession 抛错 → DB 回滚 + emit error + throw)两 restart 方法对称

## verify

- `pnpm typecheck` ✅(worktree node_modules 初装 + electron binary 手动 install)
- `pnpm exec vitest run src/main/adapters/claude-code/` — 14 文件 122/122 ✅(含 sdk-bridge __tests__ 9 文件 67/67 + 新加 24 case + `sdk-bridge.recovery.test.ts` 20/20 不退化验证 recoverer 重构不破)
- `pnpm exec vitest run src/main/session/__tests__/manager-ingest.test.ts` — 1 fail (`REVIEW_49 R3 follow-up: closed session 收到迟到 hook → advanceState short-circuit 不复活`) 是 **pre-existing**(main repo 同款 fail,与本 plan 修法无关)

## 触发

CHANGELOG_142 §触发节:用户「对前面已经做的改动进行对抗 review。然后 exit plan 选择 by pass 后,出现 SDK 流中断错误。」review 部分 CHANGELOG_142 闭环;SDK 流中断错误本 plan 闭环(走 user CLAUDE.md §复杂 plan v2 流程:Step 0 不需 RFC + Step 0.5 不需 spike + Step 1 plan 文件 + Step 1.5 deep-review 7 轮 reviewer 双对抗收口 + Step 2 EnterWorktree + Step 3a-3g + Step 4 测试 + Step 5 verify + Step 6 archive_plan)。
