# CHANGELOG_135 — `hand_off_session` adopt 语义 + spawn-link bug 双修

## 概要

Plan `hand-off-session-adopt-teammates-20260520` 收口。修两个相关问题:

1. **bug fix(主路径)**:`hand_off_session` 起的新 session 与 caller 在 SessionList UI 仍显示 lead/teammate 主子关系,与 CHANGELOG_97 baton "default 不加 team" 设计意图相违背。Phase 1 root cause 调研排除 P2(K2 mcp 漏守门)+ 实证 P3(REVIEW_39 fix 当天 14 条历史遗留数据)。Phase 2 抽 `shouldWriteSpawnLink(opts)` SSOT helper 强化 N2.a 不变量。
2. **feature add(关联)**:加 `adopt_teammates: boolean` 参数让新 session 接管 caller 同 team 当 lead;原 teammate 与新 session 共享 active team 可继续 send_message 沟通。配套 N5 ≥1 lead 硬约束 + firstTeam fatal abort + zero dual-lead window 通过 swapLead transaction atomic 实现。
3. **schema 简化**:删 `keep_teammates` 字段 + zod strict 双层命名(SHAPE 给 tool 注册 / ARGS_SCHEMA.strict().refine() 给 parse 校验)+ N2.c 互斥 invariant(adopt_teammates × team_name 不可同传)。

## 设计骨架

8 个不变量 + 11 设计决策 + 8 步骤 checklist 经 **plan Round 1-8 八轮 deep-review** 双方共识 ✅ 收口(0 真 HIGH 0 真 MED)。详 plan §不变量 + §设计决策。

## 关键不变量

- **N1** lead role swap atomic — adopt 路径 zero dual-lead window(swapLead transaction 内 caller demote + newSid INSERT 同 transaction;better-sqlite3 单 connection serializable-like 隔离)
- **N2.a** default 不写 spawn-link(`shouldWriteSpawnLink` helper 守门 batonMode=true 跳过)
- **N2.b** adopt 路径 cold-start prompt 含 team context — handler 自拼 `buildAdoptedTeamsContextBlock`(不复用 spawn `buildLeadContextBlock`,**无** wire prefix / placeholderId / "回 lead" 指令 — 避免 caller archive 后新 session 撞 send.ts shared-team enforce no-shared-team)
- **N2.c** `adopt_teammates: true × args.team_name` 互斥(zod refine reject + handler 防御性硬约束 — defense in depth)
- **N3** closed teammate 不可静默忽略(`failed.reason='lifecycle-closed'`)
- **N4** schema breaking change 单点(`keep_teammates` 删 grep == 0)+ zod strict 双层(SHAPE / ARGS_SCHEMA)
- **N5** caller=lead 上游过滤 + ≥1 lead 硬约束 fail-fast + firstTeam fatal abort(失败 → close newSid + 不 archive caller + return error)
- **N8** event emit 同步(eventBus.emit team-member-changed × 2 + sessionManager.notifyTeamMembershipChanged × 2)

## 实施(Phase 1-8)

### Phase 1 root cause 调研 P3 优先 / P2 排除(2026-05-20)
- DB SELECT spawn_depth=0 异常 14 条全部 started_at 在 2026-05-15 11:16-19:32 区间(REVIEW_39 fix commit `b3cf10c` 当天,应用主进程未重启新代码未生效)
- 5月16日 ~ 5月20日 plan base_commit(应用已重启)spawn_depth=0 异常 0 条 — fix 真正生效
- `spawn.ts:315 if (callerExists && !opts?.batonMode)` guard 在当前 codebase 完整存在 — fix 后未再触发,P2 不存在
- D9 历史 14 条数据清理不在 plan scope

### Phase 2 抽 `shouldWriteSpawnLink` helper(commit `825d258`)
- 新建 `src/main/agent-deck-mcp/tools/handlers/spawn-link-guard.ts` 独立 module helper
- spawn.ts 三处(line 38 import / 316 spawn-link 写入条件 / 482 spawnDepth fallback)改用 helper — SSOT 唯一化防双 inline 漂移
- 单测 `spawn-link-guard.test.ts` × 3 path 守门(batonMode true/false/undefined)

### Phase 3 删 `keep_teammates` + zod strict 双层命名(commit `c9d9be6`)
- `ARCHIVE_PLAN_SHAPE` / `HAND_OFF_SESSION_SHAPE` 维持 ZodRawShape(给 `tool()` + transport)
- 新增 `*_ARGS_SCHEMA = z.object(SHAPE).strict()` 给 handler / type / test 用
- type infer 切到 strict 版
- `ShutdownTeammatesResult.skipped` 枚举 `'caller-not-lead' | 'adopt-keep-implicit' | null`
- 全代码 grep `keep_teammates` 命中 0(hard gate 1)+ tools.test.ts 4 个 strict reject 守门 case(hard gate 2)
- claude-config + codex-config 文档同步

### Phase 4 加 `adopt_teammates` + 双 helper 装配 + handler adopt 路径(4 子阶段 commits `1467d40` + `5bc1ff8`)
- **Phase 4a** schemas.ts adopt_teammates 字段 + N2.c refine + HandOffSessionResult.adopted 字段 + tools.test.ts T4.3 ×3 守门
- **Phase 4b** 新建 `lead-context-block.ts` + spawn.ts SSOT refactor + `lead-context-block.test.ts` ×5
- **Phase 4c** 新建 `adopted-teams-context-block.ts`(不含 wire prefix / placeholderId / "回 lead";multi-team "attempted" + verify warning;Round 7 MED-1 删 newLeadSid 字段)+ 单测 ×7
- **Phase 4d** hand-off-session.ts adopt 分支(N5 fail-fast + snapshot lead memberships + 拼 cold-start prompt + spawn 不传 team_name + 不写 placeholder + spawnPromptMessageId 返 null + initialPrompt 一致 + 透传 adopt_teammates 给 baton-cleanup)+ baton-cleanup adoptTeammates 入参跳 phase 1 标 'adopt-keep-implicit' + adopt-teammates.test.ts ×6 + baton-cleanup.test.ts +3 case + docs 同步

### Phase 5 swapLead helper(commit `496837a`)
- `member-crud.ts swapLead` transaction atomic + 三 case 分流(case 1 INSERT 主路径 / case 2 rejoin / case 3 防御幂等 + edge case promote)+ precheck 软退三档
- 新建 `agent-deck-team-repo.swap-lead.test.ts` T5.1-T5.7 7 case(binding skip 守门)
- mock factory default stub 返 `swapped:false reason='mocked-no-op'` 防默认 success 漏测

### Phase 6 handler 内 phase 1.5 完整化(commit `d52b3ad`)
- handler 内 swapLead loop + firstTeam fatal abort(Round 5 MED-3 + Round 6 LOW-1 try/catch)+ lifecycle precheck(D6)+ N8 emit + caller-not-lead-in-team(N5 line 119)+ adopted 字段完整化(teamsTotal/teamsAdopted/preserved/failed/firstTeamId)
- +9 集成 case(T6.1-T6.X4)

### Phase 7 deep-review SKILL kind='code' 收口(3 round)
**Round 1**(commit `6a43c19`):reviewer-codex 4 finding(2 HIGH/2 MED + LOW + INFO)+ 3 新 test case(reviewer-claude 漏 4 finding):
- HIGH N2.c/N4 schema strict 没接生产 mcp tool 路径(SHAPE 注册不跑 strict.refine)→ tools/index.ts handOffSession + archivePlan tool wrapper closure 跑 ARGS_SCHEMA.safeParse + handler 入口 N2.c 防御性硬约束(defense in depth)
- MED archived team filter:adopt callerLeadMemberships filter team archivedAt + preserved teammate filter archivedAt → push failed 'session-archived'
- LOW codex-config 文档同步(补 archive_caller + adopt_teammates bullet)
- INFO T6.1 加 emit/notify spy + 新增 T4.3d/T6.A1/T6.A2 守门

**Round 2**(commit `4ca89e5`):reviewer-codex 3 finding(MED + LOW + INFO)+ 2 测试守门(reviewer-claude 仍漏):
- MED archived teammate 仍出现 cold-start prompt(spawn 之前 line 434 装配只过滤 leftAt 不过滤 archivedAt;sessionManager.archive 不 leaveTeam)→ 抽 `eligibleTeammateSidsForPrompt` helper(deps-aware lifecycle/archived precheck)
- LOW teamsTotal 含 archived ghost(数学不通)→ adoptedSnapshot 加 archivedLeadTeamIds + teamsTotal 改算 active eligibility + phase 1.5 push failed reason='team-archived'
- INFO schemas.ts adopted.failed.reason jsdoc 加 'team-archived' + 'session-archived' + claude-config / codex-config 同步

**Round 3 polish**(commit `b486590`):双方共识 ✅ 收口(reviewer-claude 0 HIGH 0 真 MED + 3 INFO future-improvement / reviewer-codex 0 HIGH 0 MED + 1 LOW)+ 顺手 codex LOW + claude INFO-5:
- LOW polish:archived team 不论 caller role 一致(lead / teammate 都 reason='team-archived')+ T4.7 加 spy + 新增 T6.A3 case
- INFO-5:schemas.ts teamsTotal 数学公式注释精度修订

**留 follow-up note 不阻合**(plan 后续 follow-up):
- claude INFO-3(adopt-local filter 未来可 SQL-化)— future-improvement 性能优化
- claude INFO-4(其他 ok-path case 加 emit spy)— future-improvement 测试覆盖
- claude INFO-6(promptGetSessionFn vs phase 1.5 getSessionFn 重复声明)— code clarity refactor
- claude INFO-7(archivedTeamIds 含 team-not-found corner case)— design choice graceful merge

## 不变量 mathematic 保证

- N1:swapLead transaction `db.transaction(callback)` 包 phase A demote(raw SQL 跳 0-lead trigger)+ phase B promote(4 case 分流)— spike2 v2 实证 archive 联动隔离 single-connection serializable-like
- N2.a:`shouldWriteSpawnLink({batonMode}): boolean` SSOT helper(spawn.ts 三处共享)
- N2.b:`buildAdoptedTeamsContextBlock` 独立 helper(不复用 `buildLeadContextBlock`)+ snapshot 双向防漂移(`adopted-teams-context-block.test.ts` ×7)
- N2.c:`HAND_OFF_SESSION_ARGS_SCHEMA.refine()` + handler 入口防御性硬约束 + tool wrapper closure 跑 strict + 3 测试守门(T4.3a/b/c + T4.3d defense-in-depth)
- N4:hard gate 1 grep == 0 + hard gate 2 zod strict reject 4 测试守门
- N5:phase 1.5 入口 `callerLeadMemberships.length === 0` fail-fast + firstTeam swapLead 失败 → close newSid + 不 archive caller + return error;非 firstTeam swapLead 软失败接受 partial adopt
- N8:swapLead 成功后立即 `eventBus.emit` × 2 + `sessionManager.notifyTeamMembershipChanged` × 2

## 测试覆盖度

- Phase 6 baseline 803 → Phase 7 final **807 tests passed**(+4 新守门 case)+ 83 skipped(SQLite binding ABI 跨 Node 版本 by-design skip)
- T4.1-T4.7 + T5.1-T5.7 + T6.1-T6.X4 + T6.A1-T6.A3 + T4.3a/b/c/d 完整覆盖 8 N invariants

## 累计 commit chain

```
b486590 Phase 7 Round 3 polish: archived team filter 不论 caller role 一致 (codex LOW + claude INFO-5)
4ca89e5 Phase 7 Round 2 fix: archived prompt filter + teamsTotal align + 文档同步
6a43c19 Phase 7 Round 1 fix: schema strict 接生产 + N2.c 双层防御 + archived filter + N8 emit spy
d52b3ad feat(handler): adopt 路径 phase 1.5 完整化 — swapLead loop + lifecycle precheck + emit (plan Phase 6)
496837a feat(team-repo): swapLead helper transaction atomic (plan Phase 5)
5bc1ff8 feat(handler): adopt_teammates handler 入口 + baton-cleanup 入参 + 集成测试 (plan Phase 4d)
1467d40 feat(schema+helper): 加 adopt_teammates 字段 + 双 helper 装配 (plan Phase 4abc)
c9d9be6 refactor(schema): 删 keep_teammates + zod strict 双层命名 (plan Phase 3)
825d258 refactor(spawn): 抽 shouldWriteSpawnLink helper SSOT 唯一化 (plan Phase 2)
```

`heterogeneous_dual_completed: true`(plan Round 1-8 + code Round 1-3 双方异构对偶共识)。详 [`plans/hand-off-session-adopt-teammates-20260520.md`](../../plans/history/hand-off-session-adopt-teammates-20260520.md)。
