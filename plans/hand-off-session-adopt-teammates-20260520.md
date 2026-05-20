---
plan_id: "hand-off-session-adopt-teammates-20260520"
created_at: "2026-05-20"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/hand-off-session-adopt-teammates-20260520"
status: "completed"
base_commit: "9893cef12bb4342314048ccb6ed728bd7c378387"
base_branch: "main"
revision: "v9 (Round 8 ✅ 双方收口 / Phase 1-6 收口 / Phase 7-8 待做)"
motivation_source: "plans/remove-aider-generic-pty-adapters-20260520.md §Follow-up F1 + user 反馈(2026-05-20)"
priority: "HIGH"
final_commit: "cdeae83e8e6e8f727ced3cd744d88057ce119025"
completed_at: "2026-05-20"
---
# `hand_off_session` adopt 语义 + spawn-link bug 双修

## 总目标

修两个相关问题:

1. **bug fix(主路径)**:用户截图显示 mcp `hand_off_session` 起的新 session 与 caller 在 SessionList UI 仍显示 lead/teammate 主子关系,与 CHANGELOG_97 baton "default 不加 team" 设计意图相违背。Phase 1 root cause 调研 P3(历史遗留)优先 / P2(K2 mcp 漏守门,概率低)次之
2. **feature add(关联)**:加 `adopt_teammates: boolean` 参数(默认 `false`),true 时:
   - **adopt 路径完全独立于 spawn lead context block**(v7-v8 演进 — Round 6 codex MED-1 + Round 7 codex MED-2 修法):spawn 不传 team_name + spawn 不写 placeholder;handler 内自己拼 **`buildAdoptedTeamsContextBlock`** 输出(`## You're the new lead — adopted teams context`,**不含** wire prefix / **不含** placeholderId / **不含** "回 lead" 指令);**swapLead transaction 内原子做 addMember(newSid, role='lead') + caller demote** → caller=lead 路径 zero dual-lead window;**adopt 路径不写 placeholder message**(无 reply chain anchor 需求 — caller 退出后无人接 reply);`spawnPromptMessageId` adopt 路径恒返 null
   - caller 同 team 其他 active+dormant teammate **原地保留**(已 active member,不需 addMember)
   - **仅 caller 是 lead 的 team 走 adopt**(N5);caller 是 teammate 的 team 跳过 + failed.reason='caller-not-lead-in-team'
   - **`adopt_teammates: true` + `args.team_name` 不可同传**(Round 3 MED-3 修法):zod refine reject(避免 silent prompt 数据丢失)
3. **schema 简化**:删除 `keep_teammates` 字段(RFC R2 Q1)+ zod schema 双层命名(NEW MED-2 修法):
   - `ARCHIVE_PLAN_SHAPE` / `HAND_OFF_SESSION_SHAPE`(raw shape 给 `tool()` 注册 + transport)
   - `ARCHIVE_PLAN_ARGS_SCHEMA = z.object(SHAPE).strict()` / `HAND_OFF_SESSION_ARGS_SCHEMA`(strict parse 给 type/test reject unknown keys)

## 动机

### Original F1 motivation

`plans/remove-aider-generic-pty-adapters-20260520.md` 实施过程中 hand_off_session 默认 shutdown caller 同 team 的 reviewer,mental model 丢失。

### User 反馈(2026-05-20)— 设计漏洞

> "为啥会有 keep_teammates,现在 keep 了,新的会话也不发进行沟通"

`keep_teammates: true` 单独使用 = 孤儿 teammate(teammate 仍 active 但与新 session 无共享 team,send_message 报 no-shared-team)。F1 解决这个隐性漏洞:`adopt_teammates` 让新 session 进入 caller 同 team 当 lead,与保留 teammate 形成共享 active team。

### bug 截图反馈

mcp `hand_off_session` 起的新 session 与 caller 在 SessionList UI 仍显示 lead/teammate 主子关系。根因优先级 P3(历史遗留)优先 / P2(K2 mcp 漏守门概率低)。

## 决策对抗 + Round 1-3 deep-review 结果

### RFC R1 + R2 + R3 (2026-05-20)

详 v1/v2/v3 §决策对抗记录(R1 Q1=K2 mcp / R1 Q2=boolean 单值 + multi-team 全要 / R1 Q4=spawn-link guard helper / R2 Q1=双重简化删 keep / R2 Q4=BEGIN TRANSACTION atomic / R3 Q1=active+dormant 一起过继 / R3 Q2=closed 试过继失败上报 / R3 Q3=spike1+2 / R3 Q4=`{preserved, failed, teamsTotal, teamsAdopted}` detail)。

### Spike 结论(详 spike-reports/)

- **spike1 v2** ✅ dormant teammate auto-resume 假设成立(claude-code + codex-cli 双 adapter)
- **spike2 v2** ✅ better-sqlite3 BEGIN TRANSACTION 原子 + archive 联动隔离 attestation

### Round 1-3 deep-review 累积(2026-05-20)

- **Round 1** 12 finding(3 HIGH + 6 MED + 3 LOW/INFO,0 反驳)→ v2 全修
- **Round 2** 7 finding(1 HIGH + 3 MED + 2 LOW + 1 INFO,0 反驳)→ v3 全修
- **Round 3** 6 finding(1 HIGH + 3 MED + 1 LOW + 1 INFO,0 反驳)→ v4 全修 — 本 file

## 不变量(plan v4)

### N1: lead role swap atomic — adopt 路径 zero dual-lead window(v4 强化)
adopt 路径下 `swapLead(teamId, callerSid, newSid, opts)` transaction 内 atomic 完成:
- caller=lead precheck(失败 swapped:false 软退)
- caller demote(SET left_at)
- newSid promote(case 1 INSERT new lead row 是 adopt 主路径,因 spawn 不写 — D11 v4 改动)/ case 2 rejoin / case 3 已 active+lead 幂等(防御)

**v4 关键**:adopt 路径 spawn **不**写 team_member(D11 重写),swapLead transaction 内 newSid 从无到有 INSERT as 'lead' + caller demote 同一 transaction → 外部 observer 永远看不到 dual-lead 中间态(spike2 §archive 联动隔离 attestation 单 connection serializable-like 隔离)。

### N2.a: default 不写 spawn-link
hand_off_session default 路径(`archive_caller=true` baton 模式)不写 sessions.spawned_by。Phase 2 抽 `shouldWriteSpawnLink(opts)` guard helper 作为防御性 invariant 强化。

### N2.b: adopt 路径 cold-start prompt 含 team context — handler 自己拼(v8 重写 — Round 7 codex MED-2 同步 v7 D11 单一语义)
**adopt_teammates: true 时 hand_off_session handler 内**:
1. 调 `findActiveMembershipsBySession(callerSid).filter(role === 'lead')` 拿 snapshot caller lead memberships(spawn 之前 freeze,不在 cleanup 时重新反查)
2. 第一个 lead-role active team(ordering `joined_at DESC` = 最近加入)+ 余下 lead-role active team:handler 内自己拼 **`buildAdoptedTeamsContextBlock`** helper 输出(`## You're the new lead — adopted teams context` + Primary team 节 + Multi-team 节 + How to communicate with teammates 节)→ prepend 到 cold-start prompt 前
3. **不复用 spawn 的 `buildLeadContextBlock`**(spawn 派出小弟语义,含"回 lead"指令 — adopt 单向交接语义不适用,Round 6 MED-1 + Round 7 MED-2 修法)
4. **adopt 路径不写 placeholder message**(无 reply chain anchor 需求,caller 退出后无人接 reply)
5. **adopt 路径不传 team_name 给 spawn**(zero spawn 副作用)— spawn 走 default baton 路径(batonMode=true / 不调 ensureByName 不调 addMember)
6. ok return.spawnPromptMessageId adopt 路径恒 null;ok return.initialPrompt 与 SDK first message 一致(schemas.ts:690-693 「完整字面」契约)

### N2.c: `adopt_teammates: true` + `args.team_name` 互斥(v4 新增,Round 3 MED-3 修法)
**zod refine 强制 reject**(schemas.ts):
```ts
HAND_OFF_SESSION_ARGS_SCHEMA = z.object(HAND_OFF_SESSION_SHAPE).strict().refine(
  (args) => !(args.adopt_teammates === true && args.team_name !== undefined),
  { message: 'adopt_teammates 与 team_name 不可同传 — adopt 路径自动过继 caller 同 team,不应指定额外 team_name' }
);
```

理由:caller 显式 `args.team_name` 通常表示「spawn 时让新 session 进这个 team(可能不在 caller 自己 team)」,与 adopt(过继 caller 自己 team)语义本来就有冲突。互斥简化语义 + 消除 silent prompt 数据丢失 bug。

### N3: closed teammate 不可静默忽略
closed teammate(`sessionRepo.get(sid).lifecycle === 'closed'`)→ `failed.push({sid, reason: 'lifecycle-closed', teamId})`,caller 必能看到。

### N4: schema breaking change 单点 + zod strict 双层(NEW MED-Y + Round 3 MED-2 强化)

**删 `keep_teammates` 字段 hard gate 1**(grep 0 hit — 排除 tools.test.ts strict reject 守门 case;hard gate 2 strict reject 守门必须含 `keep_teammates` 字面才能测 reject):
```bash
grep -RInE "keep_teammates|keepTeammates|keep-teammates" src resources --exclude-dir=node_modules --exclude='*.map' --exclude='tools.test.ts' | wc -l
# 必须 == 0
```

**zod strict 双层命名 hard gate 2**(Round 3 MED-2 修法 — 兼容现有 raw shape tool 注册接口):
- `ARCHIVE_PLAN_SHAPE` / `HAND_OFF_SESSION_SHAPE` 继续 `ZodRawShape`(给 `tool()` 注册 + transport-http/stdio 现有接口 — tools/index.ts:203-224 + transport-*.ts)
- `ARCHIVE_PLAN_ARGS_SCHEMA = z.object(ARCHIVE_PLAN_SHAPE).strict()` 显式 reject unknown keys
- `HAND_OFF_SESSION_ARGS_SCHEMA = z.object(HAND_OFF_SESSION_SHAPE).strict().refine(...)` (N2.c)
- type infer:`z.infer<typeof ARCHIVE_PLAN_ARGS_SCHEMA>`(用 strict 版,非 raw shape)
- handler 入参先走 strict ARGS_SCHEMA.parse → 反序列化时 unknown keys → throw `unrecognized_keys`
- T3.1 改:`expect(() => HAND_OFF_SESSION_ARGS_SCHEMA.parse({ keep_teammates: true })).toThrow(/unrecognized_keys/)`

### N5: failure graceful + caller=lead 上游过滤 + adopt 必须 ≥1 caller lead membership + firstTeam fatal(v6 强化)
- 新 session spawn 失败 → adopt 路径整体 abort,caller 状态零变化
- swapLead transaction 内 throw → 自动 ROLLBACK
- swapLead 返 `{ swapped: false, reason }` 软失败 → 该 team 进 failed,caller 状态零变化(precheck 在 transaction 开头,demote 未执行)
- **非 firstTeam 的 swapLead 失败** → 该 team 进 failed,其他 team 仍可成功(partial adopt)
- **caller=lead precheck 上游过滤**:adopt 路径 phase 1.5 入口先 filter `role === 'lead'`;caller 是 teammate 的 team → `failed.push({sid: callerSid, reason: 'caller-not-lead-in-team', teamId})`
- **v5 ≥1 lead 硬约束**(Round 4 MED-A1):adopt_teammates: true 但 `callerLeadMemberships.length === 0` → handler **spawn 之前 fail-fast** 返 error「adopt_teammates 要求 caller 至少在一个 active team 是 lead」,**不 spawn 新 session + 不 archive caller**
- **v6 firstTeam fatal abort**(Round 5 codex MED-3 修法 — stale anchor 防御不可执行根治):
  - phase 1.5 **先单独跑 firstTeam swapLead**(callerLeadMemberships[0])
  - **firstTeam swapLead 失败(swapped:false / throws)→ fatal abort**:
    - 不继续其他 team 的 swapLead 尝试(整体 abort)
    - shutdown newSid(`sessionManager.close(newSid)`)— spawn 已起的新 session 强制收口避免交出无法回链 prompt 的孤儿 session
    - **不 archive caller**(caller 状态零变化)
    - hand_off_session return error「adopt firstTeam swap failed: <reason>」+ 失败 team_id / failure reason 在 error.hint 中说明给 caller
  - **firstTeam swapLead 成功 → 继续 partial flow**:
    - 其他 team 单独尝试 swapLead,失败进 `failed` 但不 fatal(其他 team 失败时新 session 仍在 firstTeam 是 lead,prompt anchor 与实际 firstTeam membership 一致 → 给 firstTeam teammate send_message 仍可用;**注:adopt 路径 caller 已 archive,新 session 不能 send_message 反向回 caller**,详 D11 v7/v8 §协同关系 — Round 6 codex MED-1 deep design hole 修法)
    - caller archive(default baton)
    - return ok with adopted detail

### N6: typecheck / test / build 全绿
每 phase 末 ⚑ checkpoint。

### N7: changelog 引用归档
完成时 archive_plan tool 自动写归档。

### N8: event emit 同步
swapLead 改 caller / new session 的 team_member 状态后必须 handler 层 emit:
- `eventBus.emit('agent-deck-team-member-changed', { teamId, sessionId: callerSid, kind: 'left' })`
- `eventBus.emit('agent-deck-team-member-changed', { teamId, sessionId: newSid, kind: 'joined' })`
- `sessionManager.notifyTeamMembershipChanged(callerSid)` + `(newSid)`

## 设计决策(plan v4)

### D1: `adopt_teammates: boolean` 单值 schema + `adopt_teammates` × `args.team_name` 互斥
- `mcp__agent-deck__hand_off_session` schema 加 `adopt_teammates: z.boolean().optional()`
- **N2.c 互斥 invariant**:zod refine reject 组合
- caller multi-team 时 default 全 caller=lead 的 team adopt(N5 filter)

### D2: 删除 `keep_teammates` + zod strict 双层命名(Round 3 MED-2)

**handler 入参 / 逻辑**(必删):
- `src/main/agent-deck-mcp/tools/handlers/archive-plan.ts` `args.keep_teammates` 引用
- `src/main/agent-deck-mcp/tools/handlers/hand-off-session.ts` `args.keep_teammates` 引用
- `src/main/agent-deck-mcp/tools/handlers/baton-cleanup.ts` `keepTeammates: boolean` 入参 + phase 1 keep-teammates 分支
- `src/main/agent-deck-mcp/tools/handlers/shutdown-baton-teammates.ts` jsdoc
- `src/main/agent-deck-mcp/tools/handlers/shutdown-teammates-on-baton.ts` helper jsdoc + skipped 枚举值

**schema / 类型定义**(双层命名 + strict):
- `src/main/agent-deck-mcp/tools/schemas.ts`:
  - `ARCHIVE_PLAN_SHAPE` / `HAND_OFF_SESSION_SHAPE` 继续 `ZodRawShape`(给 `tool()` + transport 现有接口)
  - 删 `keep_teammates: z.boolean().optional()` 字段
  - 新增 `ARCHIVE_PLAN_ARGS_SCHEMA = z.object(ARCHIVE_PLAN_SHAPE).strict()` / `HAND_OFF_SESSION_ARGS_SCHEMA = z.object(HAND_OFF_SESSION_SHAPE).strict().refine(N2.c)`
  - `ShutdownTeammatesResult.skipped` 枚举从 `'caller-not-lead' | 'keep-teammates' | null` 改为 `'caller-not-lead' | 'adopt-keep-implicit' | null`
  - `shutdown_baton_teammates` tool description 4 处文字引用删
  - `z.infer<typeof ARCHIVE_PLAN_ARGS_SCHEMA>` 替代 `z.infer<z.ZodObject<typeof ARCHIVE_PLAN_SHAPE>>`(strict 类型)

**docs**(必删):
- `resources/claude-config/CLAUDE.md` mcp tool description
- `resources/codex-config/CODEX_AGENTS.md`(双 SSOT 对称)

**tests**(必删 + 加 strict reject 测试):
- 全部 `*.test.ts` 含 `keep_teammates` 引用
- 加 `tools.test.ts` strict reject case:`expect(() => HAND_OFF_SESSION_ARGS_SCHEMA.parse({ keep_teammates: true })).toThrow(/unrecognized_keys/)`
- 加 N2.c reject case:`expect(() => HAND_OFF_SESSION_ARGS_SCHEMA.parse({ adopt_teammates: true, team_name: 'X' })).toThrow(/adopt_teammates 与 team_name 不可同传/)`

### D3: `adopt_teammates: true` 自动 imply phase 1 不 shutdown
- baton-cleanup helper 多一个 `adoptTeammates: boolean` 入参
- adoptTeammates === true → phase 1 标 `skipped='adopt-keep-implicit'` + 跑 phase 1.5 adopt

### D4: lead role swap 用 `db.transaction(callback)` + caller=lead precheck + newSid INSERT 是 adopt 主路径(v4 调整)
- 新 helper `agentDeckTeamRepo.swapLead(teamId, oldLeadSid, newLeadSid, opts: { newDisplayName?: string }): { swapped: true } | { swapped: false; reason: string }` 落到 `member-crud.ts`
- transaction 内:
  ```ts
  // Phase A.0: caller=lead precheck
  const callerRow = db.prepare(
    `SELECT role FROM agent_deck_team_members WHERE team_id = ? AND session_id = ? AND left_at IS NULL`
  ).get(teamId, oldLeadSid);
  if (!callerRow) return { swapped: false, reason: 'caller-not-in-team' };
  if (callerRow.role !== 'lead') return { swapped: false, reason: 'caller-not-lead' };
  // Phase A: caller demote (SET left_at = now)
  // Phase B: newSid promote — adopt 主路径走 case 1 (因 spawn 不写 team_member)
  ```
- transaction 内三 case:
  1. **新 sid 不在 team**(adopt 主路径,因 spawn 不写)→ INSERT 新 row(role='lead', left_at=NULL)
  2. **新 sid 已 left_at row**(rejoin case,**adopt 路径不触发** — Round 4 NEW INFO 修法:newSid 是全新 spawn 永远不在 team;保留作 future-use defensive code,如别 caller 路径手工 swapLead with existing sid 触发) → UPDATE 该 row 设 role='lead' + left_at=NULL
  3. **新 sid 已 active row 且 role==='lead'**(防御边界 — N2.c 互斥 invariant 防止 adopt 路径触发此 case,但保留作 future-use defensive code) → 幂等 no-op + 仅刷 display_name
- ROLLBACK 自动;软失败 return `{ swapped: false, reason }` 三档:`'caller-not-in-team' | 'caller-not-lead' | <swapLead 内部异常>`

### D5(v6 调整)— adopt 路径 newSid 通过 swapLead 写入 + firstTeam fatal abort 路径(Round 5 codex MED-3 修法)

adopt 路径里 caller 同 team 内 teammate **原地保留**(已 active member,不需 addMember);**newSid 通过 swapLead transaction 内 INSERT 写入**(v4 关键 — v3 走 spawn(team_name)副作用,v4 不走;详 D11 v4 重写)。adopt 路径流程(v6 firstTeam fatal abort):

0. **N5 ≥1 lead 硬约束 fail-fast**(Round 4 MED-A1):adopt_teammates: true 但 callerLeadMemberships.length === 0 → handler **spawn 之前 return err**「adopt_teammates 要求 caller 至少在一个 active team 是 lead」。不进 phase 1.5 / 不 spawn / 不 archive caller
1. **caller `findActiveMembershipsBySession(callerSid)` 拿 snapshot caller 所有 active membership**(spawn 之前 freeze)
2. **filter `role === 'lead'`** — 仅 caller 是 lead 的 team 走 adopt:
   - caller 是 teammate 的 team → push 进 `failed`({sid: callerSid, teamId, reason: 'caller-not-lead-in-team'})+ continue
   - **注**:0 lead memberships 已被 N5 step 0 fail-fast 短路,此处 callerLeadMemberships.length >= 1 保证
3. **firstTeam fatal abort 路径**(v6 Round 5 MED-3 修法 — stale anchor 防御不可执行根治):
   - **先单独跑 firstTeam = callerLeadMemberships[0] 的 swapLead**:
     - **swapped: true** → 进步骤 4 继续其他 team
     - **swapped: false / throws** → **fatal abort**:
       - `sessionManager.close(newSid)` shutdown 已 spawn 的新 session(避免交出 stale firstTeam anchor 的孤儿新 session)
       - **不 archive caller**(caller 状态零变化 — phase 1.5 入口 caller 仍是 lead,swapLead transaction 内 precheck 短路 demote 未执行)
       - hand_off_session **return error**「adopt firstTeam swap failed: <reason>」+ hint(failed firstTeam id + reason)
       - phase 1.5 在此 abort,不继续其他 team / 不 emit / 不收尾
4. **firstTeam swapLead 成功后继续其他 team**(callerLeadMemberships.slice(1)— 非 firstTeam):
   - **swapLead(teamId, callerSid, newSid, { newDisplayName })** 三态分流:
     - **swapped: true** → 走步骤 5(listAllMembers + lifecycle precheck + emit)
     - **swapped: false** → push failed({sid: callerSid, teamId, reason: `'swap-lead-failed: <reason>'`}) + continue 下一 team(非 firstTeam 软失败 partial adopt 接受)
     - **throws** → catch + push failed({sid: callerSid, teamId, reason: `'swap-lead-error: <e.message>'`}) + continue
5. **listAllMembers(teamId).filter(m => m.leftAt === null && m.sessionId !== callerSid && m.sessionId !== newSid)** 拿 teammate(camelCase `leftAt`)
6. **每 teammate 显式 lifecycle precheck**(MED-A,加 `getSession?: (sid) => sessionRepo.get(sid)` test seam):
   - `session === null` → `failed.push({sid: teammateSid, teamId, reason: 'session-missing'})`
   - `session.lifecycle === 'closed'` → `failed.push({sid: teammateSid, teamId, reason: 'lifecycle-closed'})`
   - `session.lifecycle === 'active' | 'dormant'` → **`preservedSet.add(sid)`**(Round 3 LOW 修法:Set 去重)
7. **swapLead 成功后 emit**(N8):eventBus.emit × 2 + notifyTeamMembershipChanged × 2(firstTeam + 其他成功 team 都跑此步)
8. **收尾**:`preserved = Array.from(preservedSet)` + 汇总进 ok return.adopted

### D6: closed teammate 显式 fail-fast(N3)

### D7: return value `adopted` 字段 schema(Round 3 LOW + MED-1 + Round 4 LOW 修订)

```ts
adopted: {
  preserved: string[];   // 跨 team teammate sid (Set 去重保证不重复 — Round 3 LOW 修法)
  failed: Array<{
    sid: string;         // polymorphic by reason:
                         //   'caller-not-lead-in-team' / 'swap-lead-failed' / 'swap-lead-error' → callerSid
                         //   'session-missing' / 'lifecycle-closed' → teammateSid
    reason: string;
    teamId: string;
  }>;
  teamsTotal: number;    // caller 总 active team 数(含 lead + teammate)
  teamsAdopted: number;  // swapLead 成功的 team 数
  // v8 Round 7 codex INFO-3 修法:firstTeamId 仅在 ok return 路径出现 non-null
  // - 0 lead memberships 已被 N5 fail-fast → adopted/firstTeamId 不出现(handler return error)
  // - firstTeam swapLead 失败已 fatal abort return error → adopted/firstTeamId 不出现
  // - adopted/firstTeamId 仅在 ok return 路径(全 lead team adopt 完成 / partial adopt 接受)出现 non-null
  firstTeamId: string | null;  // 第一 lead team id(callerLeadMemberships[0].teamId)
} | null  // adopt_teammates: true 时 non-null
```

**hand_off_session ok return 全 schema 调整**(v8 Round 7 codex MED-2 同步 v7 D11 单一语义):
- `spawnPromptMessageId`: **adopt 路径恒返 null**(adopt 不写 placeholder — Round 6 codex MED-1 修法 / v7 D11 大改)。caller 拿到 ok return 看到 spawnPromptMessageId === null = adopt 路径(non-adopt 路径走 spawnData.spawnPromptMessageId 原写入逻辑)
- `initialPrompt`: 必与 SDK first message 一致(schemas.ts:690-693 「完整字面」契约);adopt 路径返 `coldStartPromptForSDK`(含 adopted teams context block + user prompt,不含 wire prefix);non-adopt 路径返 `resolved.coldStartPrompt`

`failed.reason` 取值:
- `'caller-not-lead-in-team'` — caller 是 teammate 不是 lead(N5 上游过滤)
- `'swap-lead-failed: <inner reason>'` — swapLead returns swapped:false
- `'swap-lead-error: <e.message>'` — swapLead throws
- `'session-missing'` — getSession 返 null(MED-A)
- `'lifecycle-closed'` — closed teammate(N3 / D6)

### D8: spawn-link guard helper(防御 invariant)
- 抽 `shouldWriteSpawnLink(opts: { batonMode: boolean }): boolean`
- spawn handler `spawn.ts:315` 改用 helper

### D9: P3 历史遗留清理(可选)
不在 plan scope。

### D10: typed scope `paths` reference 列表
- handler:`hand-off-session.ts` + `hand-off-session-impl.ts` + `baton-cleanup.ts` + `spawn.ts` + `archive-plan.ts` + `shutdown-baton-teammates.ts` + `shutdown-teammates-on-baton.ts` + **新增 `lead-context-block.ts`**(v4 — D11 重写抽 helper,**仅 spawn 路径用**)+ **新增 `adopted-teams-context-block.ts`**(v7-v8 — Round 6 codex MED-1 + Round 7 codex MED-2 修法,adopt 路径独立装配 helper,**不复用** lead-context-block.ts)
- repo:`member-crud.ts`(swapLead helper)
- schema:`schemas.ts`(adopt_teammates / keep_teammates 删 + return.adopted + ShutdownTeammatesResult.skipped 枚举 + 双层 SHAPE/SCHEMA 命名 + N2.c refine)
- types:`src/shared/types.ts`(单文件 barrel)
- test:全部 `*.test.ts`(详 D2)+ 新建 `hand-off-session.adopt-teammates.test.ts` + `agent-deck-team-repo.test.ts`(swapLead)+ 新建 `lead-context-block.test.ts`(v4 抽出的 spawn helper)+ **新建 `adopted-teams-context-block.test.ts`**(v8 抽出的 adopt helper,Round 8 codex LOW 文档清理 + claude INFO 模块位置 — adopt 独立模块 SSOT 边界清晰)
- docs:本 plan + `resources/claude-config/CLAUDE.md` + `resources/codex-config/CODEX_AGENTS.md` + tool schemas description

### D11(v7 重写)— adopt 路径独立 prompt 装配,完全不复用 spawn 的 lead context block(Round 6 codex MED-1 deep design hole 根治)

**v6 → v7 修法核心**:Round 6 codex MED-1 揭示 v6 仍漏掉 deep design hole — adopt 成功后 caller 已 archive(default baton)+ newSid 成为新 lead → caller 与 newSid 无 shared active team → 新 session 按 v6 wire prefix + lead context block 「回 lead 用 send_message」 必撞 `send.ts:52-61` no-shared-team(三处实证 send.ts + member-query.ts:141-159 findSharedActiveTeams + manager.ts:331-340 archive). v7 根治:

**核心修法**:adopt 路径**不复用** spawn 的 `buildLeadContextBlock`(它的 "回 lead 用 send_message" 指令属于 spawn 派出小弟语义,不适用于 adopt 单向交接 + caller 退出语义)。新建独立 helper `buildAdoptedTeamsContextBlock`,内容只告诉新 session "你是新 lead,接管这些 team,这些 teammate"。adopt 路径**不写 placeholder message**(无 reply chain anchor 需求 — caller 已退出无人能接 reply);`spawnPromptMessageId` 返 null。

**实现步骤**(hand_off_session handler 内 adopt_teammates 路径):

1. **spawn 之前 snapshot caller lead memberships**(同 v4/5/6,不变):
   ```ts
   if (args.adopt_teammates) {
     // N2.c invariant 已在 zod refine 层 reject args.team_name 同传,此处必为 undefined
     // N5 ≥1 lead 硬约束 已在前置 fail-fast 短路,此处 callerLeadMemberships.length >= 1 保证
     const allCallerMemberships = agentDeckTeamRepo.findActiveMembershipsBySession(caller.callerSessionId);
     const callerLeadMemberships = allCallerMemberships.filter(m => m.role === 'lead');
     // ordering: joined_at DESC (member-query.ts:89) = 最近加入的在前
   }
   ```

2. **新建 `buildAdoptedTeamsContextBlock` helper**(v7 新增 / v8 Round 7 codex MED-1 修法 — 删 newLeadSid 字段消除 ADOPT_NEW_LEAD_SID_PLACEHOLDER 替换路径不可执行问题):
   ```ts
   // src/main/agent-deck-mcp/tools/handlers/adopted-teams-context-block.ts 新建
   export function buildAdoptedTeamsContextBlock(opts: {
     // v8 删 newLeadSid 字段 — 现有 spawn/adapter contract 一次性传 promptForSpawn 不允许 spawn 后 mutate first turn prompt
     // (spawn.ts:250-253 + claude adapter sdk-bridge/index.ts:211-215 + codex adapter sdk-bridge/index.ts:451-456 实证)
     // SDK 自身 sid 已知,prompt 用 "You (the new SDK session)" 即可,不需 prompt 字面重复 newSid
     firstTeam: { id: string; name: string; teammateSids: string[] };
     otherLeadTeams: Array<{ id: string; name: string; teammateSids: string[] }>;
   }): string {
     const totalTeams = 1 + opts.otherLeadTeams.length;
     return [
       `## You're the new lead — adopted teams context (auto-injected by Agent Deck MCP)`,
       ``,
       `You (the new SDK session) just became lead of ${totalTeams} team${totalTeams > 1 ? 's' : ''} via hand_off_session adopt path.`,
       `The previous caller has handed off this baton and exited — you should not try to reply to them.`,
       ``,
       `### Primary team — \`${opts.firstTeam.name}\` (id: \`${opts.firstTeam.id}\`)`,
       `Teammate sids: ${opts.firstTeam.teammateSids.map(s => `\`${s}\``).join(', ') || '(none)'}`,
       ...(opts.otherLeadTeams.length > 0 ? [
         ``,
         // v8 Round 7 codex LOW 修法:partial adopt 时非 primary team 的 swapLead 可能失败,prompt 标 "Attempted" 不写"已 adopted"
         `### Multi-team — other teams **attempted** to adopt as lead`,
         `(verify shared team membership via \`list_sessions\` before messaging — partial adopt may have failed for some teams)`,
         ...opts.otherLeadTeams.map(t =>
           `- Team \`${t.name}\` (id: \`${t.id}\`): teammate sids ${t.teammateSids.map(s => `\`${s}\``).join(', ') || '(none)'}`
         ),
       ] : []),
       ``,
       `### How to communicate with teammates`,
       `Use \`send_message({ session_id: <teammate-sid>, team_id: <team-id>, text: ... })\` — for first-turn message omit \`reply_to_message_id\`.`,
       `Teammates' first reply will auto-include wire prefix \`[from <name>][msg <id>][sid <sid>]\` — use \`reply_to_message_id\` from that prefix on subsequent send_message to maintain reply chain.`,
       ``,
     ].join('\n');
   }
   ```

3. **handler 内拼装 cold-start prompt**(v8 简化 — 无 placeholder 替换步骤):
   ```ts
   let coldStartPromptForSDK = resolved.coldStartPrompt;

   if (callerLeadMemberships.length > 0) {
     const firstTeamMembership = callerLeadMemberships[0];
     const firstTeam = agentDeckTeamRepo.get(firstTeamMembership.teamId);
     const firstTeamTeammates = agentDeckTeamRepo
       .listAllMembers(firstTeamMembership.teamId)
       .filter(m => m.leftAt === null && m.sessionId !== caller.callerSessionId)
       .map(m => m.sessionId);

     const otherLeadTeams = callerLeadMemberships.slice(1).map(t => {
       const team = agentDeckTeamRepo.get(t.teamId);
       const teammates = agentDeckTeamRepo.listAllMembers(t.teamId)
         .filter(m => m.leftAt === null && m.sessionId !== caller.callerSessionId)
         .map(m => m.sessionId);
       return { id: t.teamId, name: team.name, teammateSids: teammates };
     });

     // v8 修法:不传 newLeadSid 字段(SDK 自身 sid 已知,helper 用 "You (the new SDK session)" 文案)
     // 直接生成 final prompt 字面字串,**不含**任何 placeholder mutation step
     const adoptedBlock = buildAdoptedTeamsContextBlock({
       firstTeam: { id: firstTeamMembership.teamId, name: firstTeam.name, teammateSids: firstTeamTeammates },
       otherLeadTeams,
     });
     coldStartPromptForSDK = `${adoptedBlock}\n---\n\n${resolved.coldStartPrompt}`;
   }
   ```

4. **spawn 调用 — 用 coldStartPromptForSDK**:不传 `team_name`(zero spawn 副作用 — spawn 走 default baton 路径 batonMode=true / 不调 ensureByName / 不调 addMember)
   - `spawnArgs.prompt = coldStartPromptForSDK`(含 adopted teams context block + user prompt)
   - `spawnArgs.team_name` 不传(N2.c reject 同传 + adopt 路径强制不传 — handler 层硬约束)
   - spawn 内 `args.team_name` 为 undefined → teamIdEarly = null → spawn 完全不调 ensureByName / addMember / placeholder write
   - spawn 返 newSid

5. **spawn 之后无需 prompt mutation**(v8 修法 — Round 7 codex MED-1 根治):
   - v7 旧设计 step 5 要求 `coldStartPromptForSDK.replace(/__ADOPT_NEW_LEAD_SID__/g, newSid)` 在 spawn 之后 mutate prompt,**不可执行**(adapter contract 一次性传 promptForSpawn,SDK 已 push 到 pending messages 才返 real id)
   - v8 简化:helper 用 "You (the new SDK session)" 文案,不依赖 newSid 字面值;spawn args.prompt 直接用 step 3 生成的 coldStartPromptForSDK,**无任何 spawn 后 mutation**
   - SDK first turn 直接收到 final prompt(adopted teams context + user prompt),新 session 通过自身 SDK session_id 自然知道自己是谁(prompt 不需重复)

6. **adopt 路径不写 placeholder message**(v7 核心修法 — Round 6 MED-1 根治):
   - **不调** `agentDeckMessageRepo.insert(...)`(避免 orphan message 残留 + 简化 DB 状态)
   - SDK first turn 投递的 prompt 通过 SDK events 仍可在 UI conversation 看到(events 表已记录),无需 placeholder
   - 理由:placeholder 主要功能是 reply chain 锚点 — adopt 路径下 caller 已退出无人接 reply,锚点无意义
   - DB audit 通过 SDK events / file_changes / summaries 子表已充分,placeholder 是冗余

7. **baton-cleanup phase 1.5 跑 adopt**(D5 路径,同 v6 不变):
   - newSid 已存在(spawn 返回)+ 仍不在任何 team
   - swapLead transaction 内 INSERT newSid as 'lead' + caller demote(D4 case 1 主路径)+ emit(N8)
   - **caller=lead 路径 zero dual-lead window**(N1 保证)

8. **hand_off_session ok return 字段**(v8 — Round 7 codex MED-2 同步):
   ```ts
   return ok({
     ...spawnData,
     // v7/v8 修法:adopt 路径不写 placeholder → spawnPromptMessageId 恒返 null
     spawnPromptMessageId: args.adopt_teammates ? null : spawnData.spawnPromptMessageId,
     // initialPrompt 必与 SDK first message 一致(schemas.ts:690-693 「完整字面」契约)
     // adopt 路径返 coldStartPromptForSDK(含 adopted teams context block + user prompt,**不含** wire prefix);
     // non-adopt 路径返 resolved.coldStartPrompt
     initialPrompt: args.adopt_teammates ? coldStartPromptForSDK : resolved.coldStartPrompt,
     adopted: { preserved, failed, teamsTotal, teamsAdopted, firstTeamId: firstTeamMembership?.teamId ?? null },
     ...
   } satisfies HandOffSessionResult);
   ```

### D11 §协同关系(v8 重写 — 含 partial adopt warning)

新 session 收到 cold-start prompt 时看到的完整结构(v8 — adopt 路径独立装配,multi-team 节加 "attempted" 标记):

```
## You're the new lead — adopted teams context (auto-injected by Agent Deck MCP)

You (the new SDK session) just became lead of N team(s) via hand_off_session adopt path.
The previous caller has handed off this baton and exited — you should not try to reply to them.

### Primary team — `<first-team-name>` (id: `<first-team-id>`)
Teammate sids: `<sid-1>`, `<sid-2>`

### Multi-team — other teams **attempted** to adopt as lead  ← v8 Round 7 codex LOW 修法:仅 multi-team(N>1)时出现 + 标 "attempted" 而非 "已 adopted"
(verify shared team membership via `list_sessions` before messaging — partial adopt may have failed for some teams)
- Team `<team-name-2>` (id: `<team-id-2>`): teammate sids `<sid-3>`, `<sid-4>`
- Team `<team-name-3>` (id: `<team-id-3>`): teammate sids `<sid-5>`

### How to communicate with teammates
Use `send_message({ session_id: <teammate-sid>, team_id: <team-id>, text: ... })` — for first-turn message omit `reply_to_message_id`.
Teammates' first reply will auto-include wire prefix `[from <name>][msg <id>][sid <sid>]` — use `reply_to_message_id` from that prefix on subsequent send_message to maintain reply chain.

---

按 <plan-abs-path> 接力(Phase: <phase_label>?)  ← 用户 prompt(plan-driven 默认)
```

**新 session 运行时行为(v8 — adopt 不支持回 caller + multi-team 验证 shared membership)**:
- ~~回 caller~~:**不支持** — adopt 路径下 caller 已 archive(default baton),新 session 与 caller 无 shared active team,send.ts shared-team enforce 必拒
- **给 primary team teammate 发新消息**:从 primary team 节拿 team_id + teammate sid → `send_message({session_id, team_id, text})` 首发不带 reply_to_message_id
- **给余下 team teammate 发新消息**(v8 注意):**先用 `list_sessions` / `get_session` 验证** newSid 与目标 teammate 共享 active team(因 partial adopt 时部分 team 可能 swap 失败,prompt 内 multi-team 节 "attempted" 标记已警示)→ 共享 active 才 send_message;否则收口该 team
- **接 teammate reply**:teammate 首次 reply 自动含 wire prefix `[msg <id>][sid <sid>]`,新 session 用 reply_to_message_id 维持 reply chain
- **DB audit**:adopt 路径无 placeholder message;新 session 与 teammate 后续 send_message 都正常写 DB,UI conversation 可见

**v7 与 v4-v6 协同关系对比**:
- v4-v6:adopt 路径复用 spawn 的 `buildLeadContextBlock`(含"回 lead"指令)+ 写 placeholder
- v7:adopt 路径独立 `buildAdoptedTeamsContextBlock`(无"回 lead"指令)+ 不写 placeholder
- 设计语义更清晰:spawn = 派出小弟 + lead 留 in-conversation;adopt = baton 单向交接 + lead 退出 + 新 session 独立运作

### D12: spike1 覆盖 codex-cli 双 adapter
spike1 v2 已实证 claude-code + codex-cli 双 adapter recoverer 路径。

## 步骤 checklist(plan v4)

### Step 0 RFC + Step 0.5 spike(已跑 ✅)

- [x] Step 0 RFC R1-R3 / Step 0.5 spike1+2 / Step 1 plan v1-v7
- [x] Round 1+2+3+4+5+6+7 deep-review
- [x] Step 1 plan v8 — 本 file
- [ ] **Step 1.5 Round 8 deep-review** — send_message 给 reviewer pair 验证 v8 修订(**强制 reviewer-claude 重读 plan body**)

### Step 2 EnterWorktree + 实施(Round 4 ✅ 收口后)

- [x] Step 2 EnterWorktree(已进 — Phase 1 调研当会话进入,worktree clean,base_commit 9893cef)

- [x] **Phase 1** root cause 调研 P3 优先 / P2 次之(plan v2/v3 同款)— 2026-05-20 收口,**P3 = root cause / P2 排除**
  - [x] (a) DB SELECT spawned_by IS NOT NULL session 时间分布:124 条 pre-fix(< b3cf10c epoch ms 1778818388000)+ 137 条 post-fix(其中 spawn_depth>=1 共 123 条是普通 spawn 派 reviewer 的合法路径 by design;spawn_depth=0 共 14 条异常)
  - [x] (b) **P3 路径成立**:14 条异常全部 started_at 在 2026-05-15 11:16-19:32 区间(REVIEW_39 fix commit b3cf10c @ 12:13:08 +0800 当天),应用主进程未重启新代码未生效。`5a15c51b`(REVIEW_39 §HIGH-1 evidence「本会话」)+ `008c3906`(REVIEW_39 evidence「codex-claude-symmetry 接力」)在异常 caller 集合中 — 与 REVIEW_39 排查时段 evidence 链对齐
  - [x] (c) **P2 K2 mcp 漏守门排除**:5月16日 ~ 5月20日 plan base_commit(应用已重启)spawn_depth=0 异常 0 条;`spawn.ts:315 if (callerExists && !opts?.batonMode)` guard 在当前 codebase 完整存在 — fix 真正生效后未再触发,P2 不存在
  - [x] D9 路径(historic 14 条数据清理)按 plan §D9 不在本 plan scope
  - ⚑ checkpoint ✅ Phase 1 收口

- [x] **Phase 2** 抽 `shouldWriteSpawnLink(opts)` guard helper(N2.a + D8)— 2026-05-20 收口
  - [x] 新建 `src/main/agent-deck-mcp/tools/handlers/spawn-link-guard.ts`(独立模块,与 lead-context-block / adopted-teams-context-block 同款风格)
  - [x] 签名 `shouldWriteSpawnLink(opts: { batonMode?: boolean }): boolean`(plan §D8 字面;callerExists 维度保留 inline 不抽,语义不同)
  - [x] spawn.ts 三处改用 helper:line 38 import / line 316 spawn-link 写入条件 / line 482 spawnDepth fallback — SSOT 唯一化防双 inline 漂移
  - [x] 单测 `src/main/agent-deck-mcp/__tests__/spawn-link-guard.test.ts`:batonMode=true→false / =false→true / undefined→true 共 3 path
  - [x] ⚑ checkpoint:typecheck ✅ / 384 tests passed (2 skipped 是 SQLite binding 跨 Node 版本自检守门,与改动无关) / build ✅

- [x] **Phase 3** 删 `keep_teammates` + zod strict 双层命名(D2 + N4 + Round 3 MED-2)— 2026-05-20 收口,commit `c9d9be6`
  - **handler / 逻辑**:同 v3 删除
  - **schema**:
    - `ARCHIVE_PLAN_SHAPE` / `HAND_OFF_SESSION_SHAPE` 继续 ZodRawShape(给 `tool()` + transport)
    - 删 `keep_teammates` 字段
    - 新增 `ARCHIVE_PLAN_ARGS_SCHEMA = z.object(ARCHIVE_PLAN_SHAPE).strict()` / `HAND_OFF_SESSION_ARGS_SCHEMA = z.object(HAND_OFF_SESSION_SHAPE).strict()`(N2.c refine 在 Phase 4 加)
    - type infer:`z.infer<typeof ARCHIVE_PLAN_ARGS_SCHEMA>` 替代旧 raw shape infer
    - `ShutdownTeammatesResult.skipped` 枚举 `'caller-not-lead' | 'adopt-keep-implicit' | null`
    - `shutdown_baton_teammates` tool description 4 处文字删
  - **docs**:resources/claude-config/CLAUDE.md + resources/codex-config/CODEX_AGENTS.md
  - **tests**:全部 *.test.ts 含 keep_teammates 删 + 加 `tools.test.ts` strict reject case `expect(() => HAND_OFF_SESSION_ARGS_SCHEMA.parse({ keep_teammates: true })).toThrow(/unrecognized_keys/)`
  - **hard gate 1** ✅:`grep -RInE "keep_teammates|keepTeammates|keep-teammates" src resources --exclude='tools.test.ts'` == 0(排除 hard gate 2 守门 case 内合法字面)
  - **hard gate 2** ✅:strict reject 测试 PASSING(tools.test.ts 4 case 守门)
  - ⚑ checkpoint:typecheck ✅ / 770 tests passed (76 skipped = SQLite binding 自检守门) ✅ / build ✅

- [ ] **Phase 4** 加 `adopt_teammates: boolean` + N2.c 互斥 invariant + N2.b handler 自拼 adopted teams context block(D1 + D7 + D11 v8 + Round 3 MED-3 + Round 6 codex MED-1 + Round 7 codex MED-2)

  **schema / type**:
  - `HAND_OFF_SESSION_SHAPE` 加 `adopt_teammates: z.boolean().optional()`
  - **N2.c invariant** 加到 `HAND_OFF_SESSION_ARGS_SCHEMA.refine(...)`(args.adopt_teammates true + args.team_name 不可同传)
  - `HandOffSessionResult` 加 `adopted: { preserved, failed, teamsTotal, teamsAdopted, firstTeamId } | null`

  **handler — N2.b handler 自拼 adopted teams context block**(v8 — Round 7 codex MED-2 修法 — adopt 路径完全独立于 spawn lead context block,不复用 buildLeadContextBlock + 不写 placeholder):
  1a. **spawn 路径 SSOT refactor**:抽 helper `src/main/agent-deck-mcp/tools/handlers/lead-context-block.ts` `buildLeadContextBlock(opts): {wirePrefix, contextBlock, placeholderId}`(从 spawn.ts:218-237 复用 sanitizeWireFieldName + 文字模板)— **仅 spawn 路径用,adopt 路径不用**
  1b. **refactor spawn.ts:218-237 inline → 调 helper**(Round 4 NEW MED-B 修法 — SSOT 唯一化):用 `buildLeadContextBlock(...)` 调用替代 spawn.ts:218-237 inline;spawn.ts test 必须用 helper 生成 fixture 守门
  1c. **snapshot test 双向防漂移**:`lead-context-block.test.ts` 加 input → output snapshot 测试;`tools.test.ts` 现有 spawn placeholder body 断言改用 helper 生成的预期串(spawn 路径 SSOT)
  1d. **adopt 路径新建独立 helper**(Round 7 codex MED-2 修法):`src/main/agent-deck-mcp/tools/handlers/adopted-teams-context-block.ts` `buildAdoptedTeamsContextBlock(opts: { firstTeam, otherLeadTeams }): string`(详 D11 step 2)— **不含 wire prefix / 不含 placeholderId / 不含"回 lead"指令** / multi-team 节标 "**attempted** to adopt as lead" + verify shared membership warning(Round 7 codex LOW 修法)
  1e. `adopted-teams-context-block.test.ts` 加 input → output snapshot 测试,确保独立性 + 不污染 spawn 路径
  2. **N5 ≥1 lead 硬约束 fail-fast**(Round 4 NEW MED-A1 修法):`if (args.adopt_teammates) { const callerLeadMemberships = findActiveMembershipsBySession(callerSid).filter(role === 'lead'); if (callerLeadMemberships.length === 0) return err('adopt_teammates 要求 caller 至少在一个 active team 是 lead'); }` — spawn 之前 fail-fast,**不 spawn / 不 archive caller**
  3. `hand-off-session.ts` 内 `if (args.adopt_teammates)`(已通过 N5 ≥1 lead precheck):
     - snapshot caller lead memberships(`findActiveMembershipsBySession.filter(role === 'lead')`)
     - 拼 `buildAdoptedTeamsContextBlock({ firstTeam, otherLeadTeams })` → `coldStartPromptForSDK = adoptedBlock + '\\n---\\n\\n' + resolved.coldStartPrompt`
     - **不复用** spawn 的 `buildLeadContextBlock`(spawn 派出小弟语义,含 "回 lead" 指令,与 adopt 单向交接不符)
     - **不维护** `coldStartPromptOriginal` 双变量(adopt 路径不写 placeholder,无需 placeholder body / SDK prompt 分离)
  4. 调 spawn:**不传** `args.team_name`(adopt 路径 always 不传 — N2.c 已 reject 显式传);`spawnArgs.prompt = coldStartPromptForSDK`(adopted teams context block + user prompt 字面)
  5. **adopt 路径不写 placeholder message**(Round 6 codex MED-1 修法 + Round 7 codex MED-2 同步):**不调** `agentDeckMessageRepo.insert(...)`;DB audit 通过 SDK events 已充分,placeholder 是冗余(caller 已退出无人接 reply,reply chain 锚点无意义)
  6. **adopt 路径无 spawn 后 prompt mutation**(Round 7 codex MED-1 修法):buildAdoptedTeamsContextBlock 删 newLeadSid 字段(adapter contract 一次性传 promptForSpawn,SDK 已 push 到 pending messages 才返 real id → spawn 后 mutate 不可执行);helper 用 "You (the new SDK session)" 文案,SDK 自身 sid 已知不需 prompt 重复
  7. handler return 时:`spawnPromptMessageId: args.adopt_teammates ? null : spawnData.spawnPromptMessageId`(adopt 路径恒 null;non-adopt 路径走 spawnData 原值)+ `initialPrompt: args.adopt_teammates ? coldStartPromptForSDK : resolved.coldStartPrompt`(Round 5 MED-2 修法)
  8. 透传 `args.adopt_teammates` 给 baton-cleanup helper

  - 同步更新 docs(claude-config / codex-config / schemas description)
  - 测试:
    - T4.1 schemas.test.ts hand_off_session args 含 `adopt_teammates: boolean`
    - T4.2 ok return shape `adopted` 字段 default null,true 时 non-null(含 firstTeamId 字段);v7 调整:`spawnPromptMessageId` adopt 路径返 null
    - T4.3 N2.c reject 守门:`expect(() => HAND_OFF_SESSION_ARGS_SCHEMA.parse({ adopt_teammates: true, team_name: 'X' })).toThrow(/adopt_teammates 与 team_name/)`
    - **T4.4(v8 重写 — Round 7 codex MED-1 + LOW 守门)N2.b 守门(single-team)**:adopt + 无 args.team_name + caller=lead 单 team → cold-start prompt:
      - `expect(spawnArgs.prompt).toMatch(/## You're the new lead — adopted teams context/)` (含 adopted teams context block)
      - `expect(spawnArgs.prompt).toMatch(/Primary team — `<firstTeamName>`/)`
      - `expect(spawnArgs.prompt).not.toMatch(/^\[from /)` (**不含** wire prefix — Round 6 MED-1 根治)
      - `expect(spawnArgs.prompt).not.toMatch(/## Hand-off context/)` (**不含** spawn-style lead context block)
      - `expect(spawnArgs.prompt).not.toMatch(/回 lead 用/)` (**不含** "回 lead" 指令)
      - **`expect(spawnArgs.prompt).not.toMatch(/__ADOPT_NEW_LEAD_SID__/)`**(Round 7 codex MED-1 修法 — newSid placeholder 替换设计删除,prompt 不含 placeholder 字串)
    - **T4.5(v8 重写 — Round 7 codex LOW 守门)N2.b 守门(multi-team N=2)**:cold-start prompt 含 primary team + 末尾追加 multi-team 节:
      - `expect(spawnArgs.prompt).toMatch(/## Multi-team — other teams \*\*attempted\*\* to adopt as lead/)`(**v8 修法** — "attempted" 标记非"已 adopted")
      - `expect(spawnArgs.prompt).toMatch(/verify shared team membership via `list_sessions`/)`(verify warning)
      - `expect(spawnArgs.prompt).toMatch(/Team `<second-team-name>`/)`(含第二 team_id / teammate sid)
      - 仍**不含** wire prefix / "回 lead" 指令(同 T4.4)
    - **T4.6(v7 重写 — Round 6 MED-1 修法)adopt 路径不写 placeholder + spawnPromptMessageId 返 null**:
      - **`expect(agentDeckMessageRepo.insert).toHaveBeenCalledTimes(0)`**(adopt 路径不写 placeholder — v7 核心修法)
      - **`expect(result.spawnPromptMessageId).toBeNull()`**(adopt 路径返 null,与 v6 spy handler 自生 id 覆盖语义不同)
      - **`expect(result.initialPrompt).toBe(spawnArgs.prompt)`**(initialPrompt 与 SDK first message 一致 — schemas.ts:690-693 「完整字面」契约)
      - **`expect(result.adopted.firstTeamId).toBe(firstTeamMembership.teamId)`**(adopt 路径 firstTeamId non-null)
    - **T4.7 N5 ≥1 lead 硬约束 fail-fast**(Round 4 MED-A1 修法):caller 无任何 caller=lead team(全 teammate / 无 active membership)+ adopt_teammates: true → handler 在 spawn 之前 fail-fast 返 error「adopt_teammates 要求 caller 至少在一个 active team 是 lead」;**spawn 未调用 + caller 未 archive**(spy spawnFn 调用 == 0 + getSession(callerSid).archivedAt == null)
  - `lead-context-block.test.ts` 新建:helper 单测(input → output snapshot 与 spawn.ts:218-237 同款);**spawn.ts test 也用 helper fixture 守门**(MED-B 修法 — 任何字段调整两处 test 同步 fail 强制 SSOT)
  - ⚑ checkpoint

- [x] **Phase 4** 加 `adopt_teammates: boolean` + N2.c 互斥 invariant + N2.b handler 自拼 adopted teams context block(D1 + D7 + D11 v8 + Round 3 MED-3 + Round 6 codex MED-1 + Round 7 codex MED-2)— 2026-05-20 收口,4 子阶段:
  - **Phase 4a** schema 改动(commit `1467d40`):HAND_OFF_SESSION_SHAPE 加 adopt_teammates 字段 + ARGS_SCHEMA.refine N2.c 互斥 + HandOffSessionResult.adopted 字段 + tools.test.ts 加 3 个 N2.c reject 守门 case (T4.3a/b/c)
  - **Phase 4b** 抽 buildLeadContextBlock helper(commit `1467d40`):新建 `lead-context-block.ts` + spawn.ts SSOT refactor(line 218-237 inline → helper) + lead-context-block.test.ts 5 cases(happy / displayName fallback / sanitize / leadAdapter sanitize / snapshot 双向防漂移)
  - **Phase 4c** 新建 buildAdoptedTeamsContextBlock helper(commit `1467d40`):`adopted-teams-context-block.ts`(不含 wire prefix / placeholderId / "回 lead" 指令;multi-team 节标 "**attempted**" + verify warning;Round 7 MED-1 删 newLeadSid 字段) + adopted-teams-context-block.test.ts 7 cases
  - **Phase 4d** handler adopt 路径 + baton-cleanup adoptTeammates 入参 + 集成测试 + docs(commit `5bc1ff8`):baton-cleanup 加 adoptTeammates 入参跳 phase 1 标 'adopt-keep-implicit' + hand-off-session.ts adopt 分支(N5 fail-fast + snapshot lead memberships + 拼 cold-start prompt + spawn 不传 team_name + 不写 placeholder + spawnPromptMessageId 返 null + initialPrompt 与 SDK 一致 + 透传 adopt_teammates 给 baton-cleanup) + adopt-teammates.test.ts 6 cases (T4.4-T4.7 + baton-cleanup 集成) + baton-cleanup.test.ts +3 cases (case 13/14/15) + docs claude-config CLAUDE.md / codex-config CODEX_AGENTS.md 同步
  - **Phase 4 阶段中间状态**:swapLead 还没在 baton-cleanup helper 跑(Phase 6 才完整化 phase 1.5),所以 adopted ok return.teamsAdopted=0 + preserved=[] + failed=[];仅 firstTeamId + teamsTotal 反映 snapshot 值
  - ⚑ checkpoint:typecheck ✅ / 794 tests passed (76 skipped) ✅ / build ✅

- [ ] **Phase 5** team-repo lead role swap helper(D4 + N1)
  - 同 v3 + 强调:adopt 主路径走 case 1(spawn 不写,newSid INSERT 是 swapLead 第一次写)
  - test 同 v3(T5.1-T5.7 含 case 1/2/3 + caller-not-lead/not-in-team precheck)
  - ⚑ checkpoint

- [x] **Phase 5** team-repo lead role swap helper(D4 + N1)— 2026-05-20 收口,commit `496837a`
  - swapLead 落 member-crud.ts;走 db.transaction(callback) 让 caller demote + newSid promote 同 transaction(N1 zero dual-lead window 实证)
  - transaction 三 case:case 1 INSERT 新 lead row(adopt 主路径)/ case 2 rejoin path UPDATE / case 3 防御幂等 / case 边角 promote teammate(bypass MAX_LEADS_PER_TEAM)
  - precheck 失败软退三档:'caller-not-in-team' / 'caller-not-lead' / 'swap-lead-error: <e.message>'
  - 新建 agent-deck-team-repo.swap-lead.test.ts T5.1-T5.7 7 case(三 case happy + 软失败 + N1 实证;binding 不可用时 skip — 与 rejoin-after-soft-exit.test.ts 同款 skip pattern)
  - mock factory(_shared/mocks/agent-deck-team-repo.ts)默认 stub 返 swapped:false reason='mocked-no-op'(防默认 success 漏测)
  - ⚑ checkpoint:typecheck ✅ / 794 tests passed (83 skipped — +7 swap-lead test 走 binding skip) ✅ / build ✅

- [x] **Phase 6** handler 内 phase 1.5 完整化(D3 + D5 + D6 + D7 + N8)— 2026-05-20 收口,commit `d52b3ad`
  - **handler 设计决策**:phase 1.5 swapLead loop 放 handler 内(plan §D5 描述「baton-cleanup phase 1.5」字面位置不强制 — 放 handler 内更测试友好,baton-cleanup helper 已支持 adoptTeammates: true 短路)
  - **firstTeam fatal abort**(Round 5 codex MED-3):firstTeam swapLead 失败(swapped:false / throws)→ closeFn(newSpawnedSid) shutdown 新 session + 不 archive caller + return error;**try/catch 围 swapLead**(Round 6 claude LOW-1)让 throws 路径同款 fatal abort
  - **firstTeam 成功后跑非 firstTeam 软失败接受 partial adopt**(D5):非 firstTeam swapLead failed → push failed + continue,caller archive 仍走
  - **lifecycle precheck**(D6):每个成功 swap 的 team listAllMembers + getSessionForLifecycle → null/closed 进 failed,active/dormant 进 preservedSet(Round 3 LOW Set 去重)
  - **N8 emit**:eventBus.emit × 2(caller 'left' + newSid 'joined') + sessionManager.notifyTeamMembershipChanged × 2
  - **caller-not-lead-in-team**(plan §N5 line 119):snapshot 时分流 lead vs teammate-only,teammate-only team push failed 让 caller 看到为什么 some team 没 adopt
  - **adopted ok return 字段完整化**:teamsTotal/teamsAdopted/preserved/failed/firstTeamId 五字段反映真实 adopt 结果
  - 新增 4 个 test seam:swapLead / getSessionForLifecycle / listAllMembersForAdopt / closeSession
  - hand-off-session.adopt-teammates.test.ts +9 集成 case(T6.1 happy / T6.2 closed / T6.3 missing / T6.4 multi-team Set 去重 / T6.X1 caller-not-lead-in-team / T6.X2 非 firstTeam 软失败 / T6.X3a/b firstTeam fatal abort 双路径 / T6.X4 partial adopt 接受);Phase 4 测试同步更新(T4.6 teamsAdopted 0 → 1)
  - ⚑ checkpoint:typecheck ✅ / 803 tests passed (83 skipped — vs Phase 5 baseline 794 + 9 new 集成 case) ✅ / build ✅

- [ ] **Phase 7** Deep-Review SKILL kind='code' 收口
  - 同 v3 D5 流程
  - **v4 关键变化**:adopt 路径不再依赖 spawn(team_name)写 newSid。phase 1.5 入口时 newSid 已存在(spawn 返回)但不在任何 team。swapLead transaction 内 INSERT newSid as lead(case 1 主路径)
  - **collected preserved 用 Set 去重**(Round 3 LOW 修法):
    ```ts
    const preservedSet = new Set<string>();
    for (const team of leadTeams) {
      const swapResult = swapLead(...);
      if (swapResult.swapped !== true) { ... continue; }
      // teammate iterate
      for (const m of teammates) {
        const session = getSession(m.sessionId);
        if (session === null) { failed.push({sid, teamId, reason: 'session-missing'}); continue; }
        if (session.lifecycle === 'closed') { failed.push({sid, teamId, reason: 'lifecycle-closed'}); continue; }
        preservedSet.add(m.sessionId);
      }
      // emit N8
    }
    return { preserved: Array.from(preservedSet), failed, teamsTotal, teamsAdopted };
    ```
  - test (`hand-off-session.adopt-teammates.test.ts` 新建):
    - T6.1 happy 路径(D5 重写 — 与 v3 同款)
    - T6.2 closed teammate → failed.reason='lifecycle-closed'
    - T6.3 session-missing → failed.reason='session-missing'
    - T6.4 multi-team caller(N=2 都 lead) → teamsTotal=2 teamsAdopted=2 + **preserved 跨 team teammate sid 去重双断言**(Round 3 LOW):`expect(adopted.preserved).toEqual(expect.arrayContaining(['A', 'B', 'C']))` + `expect(adopted.preserved.length).toBe(3)`
    - T6.5 multi-team 部分 swapLead throw → failed.reason='swap-lead-error: ...'
    - T6.6 spawn 失败 abort → caller 状态零变化(无 team_member 写入)
    - T6.7 adopt true 时 phase 1 skipped='adopt-keep-implicit'
    - T6.8 adopt false / undefined → 走 default phase 1 shutdown(回归)
    - T6.9 N8 emit 守门
    - T6.10 N2.b 守门(同 T4.4,集成视角)
    - T6.X1(NEW HIGH-X)caller-not-lead-in-team:multi-team 含 1 lead + 1 teammate team → failed=[{sid: callerSid, teamId: teammate-team-id, reason: 'caller-not-lead-in-team'}]
    - **T6.X2(v7 改名 — Round 6 MED-2 修法)非 firstTeam swapLead swapped:false 软失败**:caller=lead 在 [T1, T2] 双 team,T1 swapped:true + T2 模拟 swapLead 返 swapped:false → T2 进 failed.reason='swap-lead-failed: ...';**firstTeam(T1)swapped:false 不在本 case 测试范围 — 走 T6.X3 fatal abort**
    - **T6.11/T6.12(v6 Round 5 MED-1 修订)caller 无 active team / teammate-only single-team + adopt_teammates: true**:都走 N5 ≥1 lead 硬约束 fail-fast → `expect(handler(args)).rejects matches /adopt_teammates 要求 caller 至少在一个 active team 是 lead/`;spy spawnFn==0 + getSession(callerSid).archivedAt==null;**不返 ok with adopted=[]**(v5 矛盾的 ok-return 语义已废弃,Round 6 codex MED-2 清理)
    - **T6.13(v4 + v5 + v7 合并)D11 spawn zero side-effect 守门 + placeholder 不写守门**:adopt 路径 spawn 后 DB sessions.spawned_by IS NULL(N2.a)+ DB team_members 表 newSid 仅由 swapLead transaction INSERT(spy spawn handler 内 addMember 调用 == 0 for newSid)+ **`expect(agentDeckMessageRepo.insert).toHaveBeenCalledTimes(0)`**(v7 修法:adopt 路径不写 placeholder — Round 6 MED-1 根治,placeholder body DB invariant 守门 obsolete by 不写)
    - **T6.14(v4 新增)caller=lead zero dual-lead window**:N=1 lead team adopt 路径,在 swapLead transaction COMMIT 之前外部 SELECT countActiveLeads(team) 看到的应该是 transaction 之前的 state(=1,caller lead),transaction COMMIT 之后 = 1(newSid lead);永远不能看到 = 2(dual-lead)。better-sqlite3 单 connection serializable-like 实证(spike2 §archive 联动隔离 attestation)
    - **T6.X3(v7 拆 a/b — Round 6 claude LOW-1 修法 fatal abort 双路径守门)**:firstTeam fatal abort 路径覆盖 swapped:false + throws 两路径:
      - **T6.X3a(v6 原 T6.X3 swapped:false 路径)**:caller=lead 在 [T1, T2],模拟 T1 swapLead 返 `{ swapped: false, reason: 'caller-not-lead' }` → fatal abort:
        - hand_off_session **return error**(不返 ok with adopted)
        - error.message matches /adopt firstTeam swap failed/
        - error.hint 含 firstTeamId + reason
        - spy `sessionManager.close(newSid)` 调用 1 次(shutdown 新 session)
        - spy `sessionManager.archive(callerSid)` 调用 0 次(不 archive caller)
        - getSession(callerSid).archivedAt === null
        - T2 swapLead 不被调用(spy swapLead 仅 firstTeam 一次)
      - **T6.X3b(v7 新增 — Round 6 claude LOW-1 throws 路径守门)**:caller=lead 在 [T1, T2],模拟 T1 swapLead **throws**(模拟 FK violation / DB error)→ try/catch 围 swapLead 捕获 + 同款 fatal abort:
        - hand_off_session **return error**
        - error.message matches /adopt firstTeam swap failed/
        - error.hint 含 firstTeamId + error.message(throws 内容)
        - spy `sessionManager.close(newSid)` 调用 1 次
        - spy `sessionManager.archive(callerSid)` 调用 0 次
        - **implementer 必须 try/catch 围 swapLead 调用**,否则 throws 路径漏 fatal abort 短路 → T6.X3b 失败暴露 impl bug
    - **T6.X4(v6 新增 + v7/v8 调整)— 非 firstTeam swapLead 失败 partial adopt 接受**:caller=lead 在 [T1, T2] 双 team,T1 swapLead 成功 + T2 swapLead 失败(swapped:false 模拟)→ **partial adopt ok return**:
      - hand_off_session return ok with `adopted`
      - `adopted.firstTeamId === T1.teamId` + `adopted.teamsAdopted === 1` + `adopted.teamsTotal === 2`
      - `adopted.failed[0].sid === callerSid && failed[0].teamId === T2.teamId && failed[0].reason matches /^swap-lead-failed/`
      - `adopted.preserved` 含 T1 teammate sid(T1 swapLead 成功)
      - caller archive(default baton)
      - 新 session 在 T1 是 lead — **v8 调整(Round 7 codex LOW 修法)**:cold-start prompt **含 T1 + T2 信息但 T2 标 "attempted"**(非"已 adopted")— 新 session 看到 multi-team 节 verify warning 自然知道 T2 可能未真正 adopt → 调 list_sessions 验证 shared membership 才发 send_message;直接发 T2 send_message 仍可能撞 no-shared-team(预期 partial adopt 已知边界)
      - **v8 守门**:`expect(spawnArgs.prompt).toMatch(/Team `<T2-name>`/)` + `expect(spawnArgs.prompt).toMatch(/\*\*attempted\*\*/)` + `expect(spawnArgs.prompt).toMatch(/verify shared team membership/)`(prompt 含 T2 信息 + warning,不声称已 adopt)
      - **关键守门**:`expect(agentDeckMessageRepo.insert).toHaveBeenCalledTimes(0)`(adopt 路径不写 placeholder)+ `expect(result.spawnPromptMessageId).toBeNull()`
  - ⚑ checkpoint

- [ ] **Phase 7** Deep-Review SKILL kind='code' 收口
  - args:`{kind: 'code', paths: [<phase 2-6 改动文件>]}`
  - 反复 fix 到双 reviewer ✅ 0 HIGH 0 真 MED
  - ⚑ checkpoint

- [ ] **Phase 8** changelog + archive_plan
  - 同 v3

## 测试矩阵(plan v4)

详 Phase 2-6 各 step list 内 inline test 清单(避免重复)。重点 v4 新增:
- T4.3 N2.c reject 守门
- T4.5/T4.6 N2.b handler 自拼 prompt + placeholder 守门
- T6.13 spawn zero side-effect 守门(N1 关键 invariant)
- T6.14 caller=lead zero dual-lead window 守门

## 当前进度

- ✅ v0 → v1 → v2 → v3 → v4 → v5 → v6 → v7 → v8 → **v9 (final)**(本 file)— Round 1+2+3+4+5+6+7+8 全部 finding 修订 + Round 8 双方共识 ✅ 收口
- ✅ **Round 8 ✅ 设计收口**(reviewer-claude ✅ + reviewer-codex ✅ / 0 HIGH 0 真 MED / 仅 1 LOW + 1 INFO 非阻断已 v9 顺手清理)
- ✅ **Phase 1 root cause 调研收口(2026-05-20)** — P3 = root cause / P2 排除
  - 实证铁证:14 条 spawn_depth=0 异常全部集中 2026-05-15 fix commit b3cf10c (12:13:08 +0800) 当天 11:16-19:32 区间(应用主进程未重启)
  - REVIEW_39 evidence 链对齐:`5a15c51b` / `008c3906` 都在异常 caller 集合
  - 5月16日 ~ 5月20日 plan base_commit(应用已重启)spawn_depth=0 异常 0 条 — fix 真正生效
  - `spawn.ts:315 if (callerExists && !opts?.batonMode)` guard 当前 codebase 完整存在
  - D9 历史 14 条清理不在 plan scope
- ✅ **Phase 2 抽 shouldWriteSpawnLink helper 收口(2026-05-20)** — N2.a 防御性 invariant + SSOT 唯一化
  - 新建 `spawn-link-guard.ts` helper + 单测 3 path 守门
  - spawn.ts 三处(line 38 import / 316 spawn-link 写入条件 / 482 spawnDepth fallback)改用 helper
  - ⚑ checkpoint:typecheck ✅ / 384 tests ✅ / build ✅
- ✅ **Phase 3 删 keep_teammates + zod strict 双层命名收口(2026-05-20)** — D2 + N4 + Round 3 MED-2,commit `c9d9be6`
  - schemas.ts: `ARCHIVE_PLAN_SHAPE` / `HAND_OFF_SESSION_SHAPE` 维持 ZodRawShape + 删 keep_teammates 字段 + 新增 `*_ARGS_SCHEMA = z.object(SHAPE).strict()` 双层命名 + type infer 改 strict 版 + `ShutdownTeammatesResult.skipped` 枚举改 `'caller-not-lead' | 'adopt-keep-implicit' | null`
  - tools/index.ts:`tool()` 注册改用 `*_SHAPE` 名(import rename)
  - handlers:archive-plan.ts / hand-off-session.ts / baton-cleanup.ts / shutdown-teammates-on-baton.ts / shutdown-baton-teammates.ts 全删 keep_teammates 引用 + jsdoc 同步;baton-cleanup.ts 删 phase 1 keep-teammates 短路分支(default 永远调 helper)
  - tests:删 archive-plan / hand-off-session / baton-cleanup test 内 keep_teammates: true case + baton-cleanup 12 处 keepTeammates: false 字段;archive-plan.impl-followup test rename SCHEMA → SHAPE;tools.test.ts 加 4 个 ARGS_SCHEMA strict reject 守门 case(hard gate 2)
  - docs:resources/claude-config/CLAUDE.md + resources/codex-config/CODEX_AGENTS.md 同步 keep_teammates 字段删
  - hard gate 1 ✅:grep src + resources --exclude='tools.test.ts' 命中 0(排除 hard gate 2 守门 case 内合法字面)
  - hard gate 2 ✅:strict reject 测试 PASSING(tools.test.ts 内含旧字段 reject + generic unknown reject + happy path 回归)
  - ⚑ checkpoint:typecheck ✅ / 770 tests passed (76 skipped = SQLite binding 自检守门,与改动无关) ✅ / build ✅
- ✅ **Phase 4 加 adopt_teammates + 双 helper 装配 + handler adopt 路径收口(2026-05-20)** — D1 + D7 + D11 v8 + Round 6 MED-1 + Round 7 MED-1/MED-2,4 子阶段 commits `1467d40` (schema + 双 helper) + `5bc1ff8` (handler adopt 路径 + baton-cleanup 入参 + 集成测试 + docs)
  - Phase 4a: schemas.ts adopt_teammates 字段 + N2.c refine + HandOffSessionResult.adopted + tools.test.ts T4.3 ×3 守门
  - Phase 4b: 新建 lead-context-block.ts + spawn.ts SSOT refactor + lead-context-block.test.ts ×5
  - Phase 4c: 新建 adopted-teams-context-block.ts(不含 wire prefix / placeholderId / "回 lead";multi-team "attempted" + verify warning) + adopted-teams-context-block.test.ts ×7
  - Phase 4d: hand-off-session.ts adopt 分支(N5 fail-fast + snapshot lead memberships + 拼 cold-start prompt + spawn 不传 team_name + 不写 placeholder + spawnPromptMessageId 返 null + initialPrompt 一致 + 透传 adopt_teammates 给 baton-cleanup) + baton-cleanup adoptTeammates 入参跳 phase 1 标 'adopt-keep-implicit' + adopt-teammates.test.ts ×6 (T4.4-T4.7 + 集成) + baton-cleanup.test.ts +3 (case 13/14/15) + docs(claude-config / codex-config)
  - **Phase 4 阶段中间状态**:swapLead 还没在 baton-cleanup helper 跑(Phase 6 才完整化 phase 1.5),adopted ok return.teamsAdopted=0 + preserved=[] + failed=[];firstTeamId + teamsTotal 反映 snapshot 值
  - ⚑ checkpoint:typecheck ✅ / 794 tests passed (76 skipped) ✅ / build ✅
- ✅ **Phase 5 swapLead helper 收口(2026-05-20)** — D4 + N1,commit `496837a`
  - member-crud.ts swapLead transaction atomic + 三 case 分流 + precheck 软退三档
  - agent-deck-team-repo.swap-lead.test.ts T5.1-T5.7 7 case(binding skip 守门)
- ✅ **Phase 6 handler 内 phase 1.5 完整化收口(2026-05-20)** — D3 + D5 + D6 + D7 + N8,commit `d52b3ad`
  - handler 内 swapLead loop + firstTeam fatal abort(Round 5 MED-3 + Round 6 LOW-1)+ lifecycle precheck(D6)+ N8 emit + caller-not-lead-in-team(N5 line 119)+ adopted 字段完整化
  - +9 集成 case(T6.1-T6.X4)
  - ⚑ checkpoint:typecheck ✅ / 803 tests passed (83 skipped) ✅ / build ✅
- ⏳ Phase 7-8 实施(Phase 7 deep-review SKILL kind='code' / Phase 8 changelog + archive_plan)

## 下一会话第一步

如果是新会话接力 Phase 7:

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/hand-off-session-adopt-teammates-20260520.md` 全文读(优先 §步骤 checklist Phase 7)
2. EnterWorktree(path: `/Users/apple/Repository/personal/agent-deck/.claude/worktrees/hand-off-session-adopt-teammates-20260520`)— worktree 已存在(Phase 1-6 用过,clean,HEAD=`d52b3ad`)
3. `git -C <worktree> rev-parse HEAD` 自检为 `d52b3ad`(Phase 6 commit),在 main HEAD `9893cef` 之后
4. 按 §步骤 checklist Phase 7 直接动手:
   - 调 `/agent-deck:deep-review` SKILL 走多轮异构对抗 review (kind='code'),scope = Phase 2-6 改动文件:
     - schema:`src/main/agent-deck-mcp/tools/schemas.ts`
     - handler:`src/main/agent-deck-mcp/tools/handlers/{spawn-link-guard,baton-cleanup,archive-plan,hand-off-session,shutdown-baton-teammates,shutdown-teammates-on-baton,spawn,lead-context-block,adopted-teams-context-block}.ts`
     - 工具:`src/main/agent-deck-mcp/tools/index.ts`
     - repo:`src/main/store/agent-deck-team-repo/{member-crud,index}.ts`
     - tests:`src/main/agent-deck-mcp/__tests__/{tools,baton-cleanup,archive-plan.handler,hand-off-session.handler-deny-happy,hand-off-session.adopt-teammates,dormant-teammate-shutdown,lead-context-block,adopted-teams-context-block,spawn-link-guard}.test.ts` + `src/main/store/__tests__/agent-deck-team-repo.swap-lead.test.ts`
     - mock:`src/main/__tests__/_shared/mocks/agent-deck-team-repo.ts`
     - docs:`resources/claude-config/CLAUDE.md` + `resources/codex-config/CODEX_AGENTS.md`
   - 反复 fix 到双 reviewer ✅ 0 HIGH 0 真 MED
5. ⚑ checkpoint:typecheck + test + build 全绿

如果是从 Phase 6 后直接续做 Phase 7:跳过步骤 2(已在 worktree),跳过步骤 1(plan 已 cat 过本会话)。

## 已知踩坑

- **dormant teammate auto-resume 假设**:spike1 v2 已实证双 adapter 路径
- **lead role swap 原子性**:spike2 v2 实证 + archive 联动隔离 attestation
- **swapLead 第三 case**(MED-C 防御):adopt 主路径走 case 1(spawn 不写,INSERT 新 row 是 swapLead 第一次写);case 2 在 adopt 路径 dead code(newSid 全新 spawn 永不在 team_members 表,Round 4 INFO 修法 — 保留作 future-use defensive code);case 3 防御保留(N2.c 互斥 invariant 防止 adopt 路径触发,但保留 future-use)
- **caller=lead precheck 是 swapLead 硬约束**:N5 + D4 双重防御(handler 上游 filter + swapLead 内 precheck)+ **N5 ≥1 lead 硬约束**(Round 4 MED-A1):adopt_teammates: true 但 caller 在所有 team 都不是 lead → handler fail-fast,不 spawn / 不 archive caller + N5 firstTeam fatal abort(Round 5 MED-3 修法)
- **multi-team caller 行为复杂度**(v8):adopt + N=2+ 时 primary team 走 adopt teams context 第一节,余下 lead-role team 走 multi-team 节(标 "**attempted**" + verify shared membership warning);preserved Set 去重保证跨 team sid 不重复
- **breaking change keep_teammates 删除**:N4 hard gate 1(grep == 0)+ hard gate 2(zod strict reject)
- **N2.c 互斥 invariant**:adopt_teammates: true + args.team_name 同传必 zod refine reject;消除 spawn 副作用污染 + slice(1) 假设始终成立
- **closed teammate / session-missing teammate** 显式 fail-fast 进 failed.reason
- **字段名 leftAt 非 left_at**:repo 返 camelCase
- **zod strict 双层命名**:`SHAPE`(raw,给 tool/transport)+ `ARGS_SCHEMA`(strict,给 parse/type/test)— 必须配对维护
- **D11 v8 final design — adopt 路径完全独立装配**(权威设计 — Round 6 codex MED-1 + Round 7 codex MED-2 + Round 8 codex LOW 修法,v4-v7 历史描述已 obsolete 并清理):
  - adopt 路径 **不复用** spawn 的 `buildLeadContextBlock`(spawn 派出小弟语义,含 "回 lead" 指令);**新建独立** `buildAdoptedTeamsContextBlock` (adopt 单向交接语义)
  - prompt 内容:`## You're the new lead — adopted teams context` + Primary team 节 + Multi-team 节(标 "**attempted**" + verify shared membership warning,Round 7 codex LOW 修法)+ How to communicate with teammates 节
  - **不含** wire prefix `[from ...]` / **不含** placeholderId / **不含** "回 lead 用 send_message" 指令(避免 caller archive 后新 session 撞 send.ts:52-61 no-shared-team)
  - **adopt 路径不写 placeholder message**(无 reply chain anchor 需求 — caller 退出后无人接 reply;DB audit 通过 SDK events 已充分)
  - `spawnPromptMessageId` adopt 路径恒返 null;`initialPrompt` 与 SDK first message 字面一致(adopt 返 coldStartPromptForSDK 含 adopted teams context block + user prompt 不含 wire prefix)
  - **不在 spawn 之后 mutate prompt**(adapter contract 一次性传 promptForSpawn,SDK 已 push 到 pending messages 才返 real id;Round 7 codex MED-1 修法 — buildAdoptedTeamsContextBlock 删 newLeadSid 字段,prompt 用 "You (the new SDK session)" 文案,SDK 自身 sid 已知不需 prompt 重复)
- **partial adopt 失败 team cascading auto-archive**(Round 6 claude LOW-2):非 firstTeam swapLead 失败时,caller 仍是该 team 的 lead → caller archive(default baton)触发 `archiveTeamsIfOrphaned`(manager-team-coordinator.ts:97-122)→ countActiveLeads(team) === 0 → team auto-archive → 该 team teammates 与 newSid 失去 active shared team。**default baton 同款 cascading 行为不是 adopt 独有 bug**;caller 通过 return.adopted.failed 反查决定是否手动重建 / 接受 partial(详 T6.X4 已知行为不算 bug)
- **D7 firstTeamId / spawnPromptMessageId 仅 ok return 路径**(Round 6 claude INFO-3 + Round 7 codex MED-2):
  - 0 lead memberships 已被 N5 fail-fast → adopted/firstTeamId 不出现
  - firstTeam swapLead 失败已 fatal abort return error → adopted 不出现
  - adopted/firstTeamId 仅在 ok return 路径(全 lead team adopt 完成 / partial adopt 接受)出现 non-null
  - spawnPromptMessageId v8 adopt 路径恒返 null(不写 placeholder),non-adopt 路径走 spawn 原写入逻辑
- **firstTeam swapLead 失败 → fatal abort**(Round 5 MED-3 修法,v6+ 保留):
  - **修法**:firstTeam swapLead 失败 → fatal abort:`sessionManager.close(newSid)` shutdown 新 session + 不 archive caller + return error,不继续其他 team 的 swapLead
  - **caller 防御路径**:看到 error 后:① 修复 firstTeam(用户 spawn 同名 teammate / 修复 DB / 排查为啥 swapLead 撞 invariant)+ 重试 hand_off_session ② 改走 default baton(`adopt_teammates: false`)放弃 adopt 走 normal hand-off
  - **概率极低**:caller 自己刚验证 lead in firstTeam(N2.b filter + N5 ≥1 lead precheck),swapLead 内部 precheck 再次确认;FK / MAX_LEADS / 数据库 race 同时撞概率极低;如撞了 fatal abort 是合理回滚,不交出半残新 session
- **MAX_LEADS_PER_TEAM bypass**(Round 3 NEW INFO):swapLead transaction 内 INSERT 走 raw SQL,跳 `agentDeckTeamRepo.addMember` 内 `countActiveLeads >= MAX_LEADS_PER_TEAM=10` 校验。F1 use case 不撞(典型 1-2 lead/team)。**未来若用法扩展**(N≥10 lead 场景)需在 swapLead Phase B 前补 countActiveLeads check + return swapped:false reason='max-leads'
- **D11 lead context block helper SSOT**:从 spawn.ts:218-237 抽到 `lead-context-block.ts`,**两处 caller(spawn / hand-off adopt 路径)共享**;Phase 4 step 1b 必同时 refactor spawn.ts inline → 调 helper(Round 4 MED-B 修法,避免双 SSOT 漂移)
- **D4 case 2 在 adopt 路径 dead code**(Round 4 NEW INFO):newSid 全新 spawn 永不在 team_members 表内,case 2 (rejoin path,触发 newSid 已 left_at != null 行)在 adopt scope 永不触发;保留作 future-use defensive code(同 case 3 同款标注)

## Sister-plan

`plans/add-claude-cli-path-override-and-bump-sdks-20260520.md`(MED 优先级,与 F1 正交)。

## 裁决记录

### Round 1 deep-review 12 finding(2026-05-20)
**3 HIGH 双方独立 + 6 MED 单方现场实证 + 3 LOW/INFO** → v2 全修。详 v2/v3 plan 历史版本。

### Round 2 deep-review 7 finding(2026-05-20)
**1 HIGH 双方互补 + 3 MED 单方现场实证 + 2 LOW + 1 INFO** → v3 全修。

### Round 3 deep-review 6 finding(2026-05-20)

| # | 等级 | 来源 | finding | v4 修法 |
|---|---|---|---|---|
| **HIGH** | ✅ 真 HIGH | codex HIGH(claude Round 3 评审漏掉这个 caller=lead 主路径 dual-lead 盲点)| D11 仍复用 spawn(team_name) — caller=lead 时 spawn 先 addMember(newSid, role='lead'),swapLead 后 demote → caller=lead 主路径有 dual-lead window violates N1;args.team_name 显式传时不受 N2.b filter 保护污染 adopt scope | **D11 重写不复用 spawn(team_name) 副作用** — adopt 路径 spawn 不传 team_name(spawn 不写 team_member);handler 内自己拼 wire prefix + lead context block(抽 lead-context-block.ts helper);swapLead transaction 内 INSERT newSid as lead + caller demote atomic(zero dual-lead window) |
| **MED-1** | ✅ 真 MED | codex(N5/D5/T6.12 三处矛盾实证) | T6.12 caller teammate-only single-team 返 `failed: []` 与 N5/D5 要求 `failed.reason='caller-not-lead-in-team'` 矛盾 | T6.12 改与 N5/D5 一致:`failed: [{sid: callerSid, teamId, reason: 'caller-not-lead-in-team'}]` |
| **MED-2** | ✅ 真 MED | codex(tools/index.ts + transport 实证) | zod strict 改造撞现有 raw-shape tool 注册接口 | 拆两层命名:`*_SHAPE`(raw,给 tool/transport)+ `*_ARGS_SCHEMA = z.object(SHAPE).strict()`(给 parse/type/test);type infer 用 `z.infer<typeof ..._ARGS_SCHEMA>` |
| **MED-3** | ✅ 真 MED | claude(slice(1) 假设静态推理实证) | D11 multi-team block `slice(1)` 假设仅 auto-derive 路径正确;`args.team_name` 显式传 + adopt_teammates 时 silent prompt 数据丢失 | **N2.c 新增 invariant**:`adopt_teammates: true` + `args.team_name` 不可同传(zod refine reject)— 简化语义消除 silent bug + slice(1) 假设始终成立 |
| **LOW** | ✅ 修 | claude(T6.4 与 D5/D7 不一致) | preserved 字段跨 team sid 去重逻辑不显式说明 | D5 step 5 改 `preservedSet.add(sid)` + Phase 6 收尾 `Array.from(preservedSet)`;D7 注释加 dedup;T6.4 双断言 |
| **INFO** | ✅ 顺手 | claude(member-crud.ts:75-78 实证) | D4 case 1/2 INSERT bypass MAX_LEADS_PER_TEAM 校验(F1 不撞) | §已知踩坑 加注 |

**Round 3 总结**:1 HIGH 双方互补(codex 抓到 claude 漏的盲点);3 MED 单方独有 + 现场实证强;1 LOW + 1 INFO 顺手修。0 反驳。

### Round 4 deep-review 5 finding(2026-05-20)

**Round 3 6 finding ✅ 全部充分修订**(reviewer-claude / reviewer-codex 双方 Round 4 reply confirm)。

**v4 引入新 finding**:

| # | 等级 | 来源 | finding | v5 修法 |
|---|---|---|---|---|
| **MED-A** | ✅ 真 MED(双方独立) | claude NEW MED-A + codex MED-A2(同根因) | D11 v4 placeholder body 用 `resolved.coldStartPrompt`(已含 wire prefix)违反 spawn.ts:196/442 + tools.test.ts:633 + 应用 CLAUDE.md:70 SSOT「DB messages.body 不含 wire prefix」 | D11 step 3 拆变量 `coldStartPromptOriginal`(placeholder body 不含 wire prefix)+ `coldStartPromptForSDK`(spawn args.prompt 含全部);step 6 placeholder body 用 `coldStartPromptOriginal`;step 8 return `spawnPromptMessageId: handlerPlaceholderId ?? spawnData.spawnPromptMessageId` 覆盖 |
| **MED-A1** | ✅ 真 MED | codex 单方 + send.ts:52-61/86-99 shared-team enforce 实证 | firstTeam reply anchor 在 swapLead 成功前已暴露 — adopt spawn 之前 prompt 已 prepend firstTeam wire prefix + team_id;swapLead 在 spawn 之后才跑;**firstTeam swapLead 软失败时新 session 已收到 stale anchor** → 调 send_message 撞 no-shared-team / cross-team reply | N5 强化:adopt 必须 ≥1 caller lead membership(handler fail-fast);D7 加 `firstTeamId` 字段让 caller 反查;§已知踩坑加 trade-off 接受文档化 + caller 防御路径(shutdown 新 session 重试 / send_message follow-up 解释 / 接受 partial adopt);T6.X3 加 stale anchor 守门 + trade-off 测试断言 |
| **MED-B** | ✅ 真 MED | claude 单方 + SSOT 漂移推理 | Phase 4 step 1 仅说「抽 helper 给 hand-off-adopt 用」,**没要求 refactor spawn.ts:218-237 改用 helper** → 抽出后两份逻辑独立维护 SSOT 漂移 | Phase 4 step 1 拆 (a) 抽 helper / (b) refactor spawn.ts:218-237 inline → 调 helper / (c) snapshot test 双向防漂移;§已知踩坑 同步注 |
| **LOW** | ✅ 修(claude + codex MED-A 第二部分 overlap) | claude single | adopt 路径 spawnPromptMessageId 永远 null,handler 自己 placeholder messageId 没 surface | return 覆盖(MED-A 修法一并)+ T4.6 加 assert |
| **INFO** | ✅ 顺手 | claude single | D4 case 2 (rejoin path) 在 adopt 路径 dead code | case 2 注释加「adopt 路径不触发,保留作 future-use defensive code」(同 case 3 同款标注)+ §已知踩坑 加注 |

**Round 4 总结**:0 真 HIGH;3 真 MED(MED-A 双方独立 / MED-A1 + MED-B 单方独有 + 现场实证强);1 LOW + 1 INFO 顺手修。0 反驳。

### Round 5 deep-review 3 finding(2026-05-20)

**reviewer-claude Round 5**:✅ 收口 / 0 HIGH 0 真 MED(逐项验证 Round 4 修订充分 + v5 未引入新真 MED+;附 3 个非 finding impl-level INFO 观察)
**reviewer-codex Round 5**:❌ 未收口 / 0 HIGH 3 MED(claude 漏掉的 cross-reference / 字段对齐 / 防御实际可执行性盲点)

| # | 等级 | 来源 | finding | v6 修法 |
|---|---|---|---|---|
| **MED-1** | ✅ 真 MED | codex(N5/T6.11/T6.12 三处 plan 自身矛盾实证) | T6.11/T6.12 与 N5 fail-fast 矛盾 — N5 说 0 lead → handler spawn 前 fail-fast 返 error,但 Phase 6 测试 T6.11(caller 无 active team)+ T6.12(caller teammate-only single-team)仍写 ok return adopted 把 N5 测回旧语义 | 删 T6.11/T6.12 ok return → 改 fail-fast error 断言(同 T4.7 共用语义);D5 step 0 显式列 N5 ≥1 lead 硬约束 fail-fast |
| **MED-2** | ✅ 真 MED | codex(schemas.ts:690-693 + hand-off-session.ts:426 双实证) | D11 双变量修法漏更新 `initialPrompt` — v5 改 `spawnArgs.prompt = coldStartPromptForSDK`,但 hand-off-session.ts 仍返 `initialPrompt: resolved.coldStartPrompt`(原值不含 wire prefix)→ 实施后 SDK 收到含 wire prefix 但 ok return.initialPrompt 不含 → schemas.ts 「完整字面 first message」契约失真 | D11 step 8 加 `initialPrompt: args.adopt_teammates ? coldStartPromptForSDK : resolved.coldStartPrompt`;T4.6 加 `expect(result.initialPrompt).toBe(spawnArgs.prompt)` 守门 |
| **MED-3** | ✅ 真 MED | codex(send.ts:52-61 + member-query.ts:141-159 + manager.ts:331-340 三处实证) | stale anchor 防御路径不可执行 — v5 §已知踩坑说 caller 可 send_message follow-up,但 adopt 成功后 caller 已 archive(default baton)+ firstTeam swapLead 失败 newSid 没进 firstTeam → caller 与 newSid 无共享 active team → send.ts shared-team enforce 必报 no-shared-team | **走 codex 推荐 fatal 修法**:firstTeam swapLead 失败 → adopt 整体 fatal abort(N5 + D5 step 3 重写)— 不继续 partial adopt + shutdown newSid + 不 archive caller + return error;§已知踩坑 stale anchor 节重写为 fatal abort 语义;T6.X3 改 fatal abort 测试断言 + T6.X4 新增非 firstTeam 失败 partial adopt 接受守门 |

**Round 5 总结**:0 真 HIGH;3 真 MED(全 codex 单方独有 + 现场实证强 — claude 漏掉 cross-reference / 字段对齐 / 防御可执行性盲点)。0 反驳。reviewer-claude ✅ 与 reviewer-codex ❌ 不一致 → 走 codex 修法(双方共识需 v6 + Round 6 重新验证)。

### Round 6 deep-review 7 finding(2026-05-20)

**reviewer-claude Round 6**:✅ 收口 / 0 HIGH 0 真 MED(逐项验证 Round 5 修订充分 + v6 未引入新真 MED+;附 2 LOW + 2 INFO 完整性观察 非 finding)
**reviewer-codex Round 6**:❌ 未收口 / 0 HIGH 2 MED 1 LOW(claude 漏掉的 deep design hole / 自身矛盾清理 / 文档过期盲点)

| # | 等级 | 来源 | finding | v7 修法 |
|---|---|---|---|---|
| **MED-1** | ✅ 真 MED | codex 单方 + 三处现场实证(send.ts:52-61 + member-query.ts:141-159 + manager.ts:331-340) | adopt 成功路径仍注入"回 caller"锚点,但 swapLead 后 newSid 与 caller 无 shared active team — caller demote/left + newSid 成为 lead + default archive caller → 新 session 按 wire prefix + lead context block 「回 lead 用 send_message」 必撞 no-shared-team(deep design hole — claude 漏 因没深入 send.ts shared-team enforce SQL) | **D11 v7 大改** — adopt 路径完全独立 prompt 装配:不复用 `buildLeadContextBlock`,新建 `buildAdoptedTeamsContextBlock`(`## You're the new lead — adopted teams context`,不含 wire prefix / placeholderId / "回 lead" 指令);**adopt 路径不写 placeholder message**(无 reply chain anchor 需求 — caller 退出后无人接 reply);`spawnPromptMessageId` adopt 路径返 null;§协同关系节重写(删"回 caller"路径,新 session 仅 forward 给 teammate)|
| **MED-2** | ✅ 真 MED | codex 单方 + plan 自身矛盾实证 | Phase 6 矩阵旧 T6.11/T6.12 ok-return + T6.X2 没删,与新 fail-fast 断言 + T6.X3 fatal abort 并存 → 同矩阵两种语义实施时冲突 | 删旧 T6.11/T6.12 ok-return 条目;T6.X2 改名/改范围:**仅** 非 firstTeam swapped:false 软失败(firstTeam swapped:false 走 T6.X3 fatal abort);保留单一语义 — 0 lead → fail-fast / firstTeam fail → fatal / non-firstTeam fail → partial ok |
| **LOW (codex)** | ✅ 修 | codex single | §下一会话第一步仍写 v4/Round 4/Round 5 → 冷启动误导 | 更新 v7/Round 6/Round 7 prompt |
| **claude LOW-1** | ✅ 修 | claude single | T6.X3 仅覆盖 swapped:false 路径,throws 路径未显式 test case → impl 时漏 try/catch 测试不能 catch | T6.X3 拆 T6.X3a (swapped:false) + T6.X3b (throws,模拟 FK violation),都断言 shutdown newSid spy=1 + archivedAt=null + return error;**implementer 必须 try/catch 围 swapLead** 否则 T6.X3b 失败暴露 impl bug |
| **claude LOW-2** | ✅ 修 | claude single + archiveTeamsIfOrphaned 实证 | partial adopt 失败 team caller archive 后触发 archiveTeamsIfOrphaned auto-archive 该 team teammates 与 newSid 失去 active shared team — default baton 同款 cascading 行为但 plan 未明示 | §已知踩坑 partial adopt 节加 cascading effect 文档化(default baton 同款行为,通过 return.adopted.failed 反查) |
| **claude INFO-3** | ✅ 顺手 | claude single | D7 firstTeamId 注释只说 N5 fail-fast,未明示 fatal abort 路径也不返 ok with adopted | D7 注释扩展「0 lead memberships 已被 N5 fail-fast / firstTeam swapLead 失败已 fatal abort return error — adopted/firstTeamId 仅在 ok return 路径出现」 |
| **claude INFO-4** | 不再适用 | claude single | fatal abort 下 placeholder orphan(toSessionId=newSid 但 newSid close) | **v7 自动 obsolete** — codex MED-1 修法决定 adopt 路径完全不写 placeholder,placeholder orphan 问题不存在 |

**Round 6 总结**:0 真 HIGH;2 真 MED(全 codex 单方独有 — claude focus 字段对齐 + 时序,**没深入新 session 回 caller 实际可执行性需读 send.ts shared-team enforce SQL**);1 LOW(codex)+ 2 LOW(claude)+ 1 INFO(claude)顺手修 + 1 INFO(claude)自动 obsolete。0 反驳。reviewer-claude ✅ 与 reviewer-codex ❌ 不一致 → 走 codex 修法(MED-1 + MED-2 + LOW)+ claude LOW/INFO 一并修。

### Round 7 deep-review 3 finding(2026-05-20)

**reviewer-claude Round 7**:✅ 收口 / 0 HIGH 0 真 MED + 2 INFO(**scope 受限**:claude 显式声明 "text-only 约束 + compact 后 plan body 超 turn 容量 → plan body 未重读,基于 Round 6 baseline + Round 7 skip clauses 描述做验证";disclaim "如 v7 plan body 实际落地与 skip clauses 描述不一致,next cycle 直读 v7 重对照")
**reviewer-codex Round 7**:❌ 未收口 / 0 HIGH 2 MED 1 LOW(**真读了 plan body**,抓到 v7 修订实际疏漏 — claude 因 scope 受限漏掉)

| # | 等级 | 来源 | finding | v8 修法 |
|---|---|---|---|---|
| **MED-1** | ✅ 真 MED | codex 单方 + 三处实证(spawn.ts:250-253 + claude adapter sdk-bridge/index.ts:211-215 + codex adapter sdk-bridge/index.ts:451-456 + thread-loop.ts:210-228) | v7 D11 step 5 newSid placeholder 替换设计**不符现有 spawn/adapter 时序** — adapter contract 一次性传 promptForSpawn,SDK 已 push 到 pending messages 才返 real id → 主路径不可执行,SDK 首轮会收到 `__ADOPT_NEW_LEAD_SID__` 字串 | **删 newLeadSid 字段** — buildAdoptedTeamsContextBlock 输入字段去除 newLeadSid,prompt 用 "You (the new SDK session)" 文案(SDK 自身 sid 已知不需 prompt 重复);删 step 5 string.replace 步骤;T4.4 加 `expect(spawnArgs.prompt).not.toMatch(/__ADOPT_NEW_LEAD_SID__/)` 守门 |
| **MED-2** | ✅ 真 MED | codex 单方 + plan 自身多处冲突实证(N2.b line 75-80 + D7 line 252-254 + Phase 4 line 491-504 + N5 line 127) | v7 新语义未同步到 N2.b/D7/Phase 4/N5 → 旧 wire-prefix/placeholder/handler 自生 spawnPromptMessageId/"send_message 反向回 caller" 路径仍是权威 checklist → implementer 按 Phase 4 执行会复活 Round 6 MED-1 旧语义 | 全文同步 v7/v8 单一语义:N2.b 重写(adopted teams context block 不含 wire prefix)+ D7 改(spawnPromptMessageId adopt 恒 null + 注释扩展 fatal abort 路径不返 adopted)+ Phase 4 重写 adopt 路径分支(不写 placeholder + spawnPromptMessageId null + 不复用 buildLeadContextBlock + 新建 buildAdoptedTeamsContextBlock helper)+ N5 删 "send_message 反向回 caller" |
| **LOW** | ✅ 修 | codex 单方 + plan 自身 prompt 与事实不符实证 | partial adopt 时 D11 在 swap 之前构造 otherLeadTeams 写进 prompt → T2 swap 失败后新 session prompt 声称已接管 T2 但实际未接管 — 与事实不符 | buildAdoptedTeamsContextBlock multi-team 节文字改 "**Attempted** to adopt as lead" + "verify shared team membership via list_sessions before messaging" warning;T6.X4 加 warning 字串守门 + T4.5 加 `expect(prompt).toMatch(/\*\*attempted\*\*/)` + `verify shared team membership` 守门 |

**Round 7 总结**:0 真 HIGH;2 真 MED + 1 LOW(全 codex 单方独有 + 现场实证强 — claude scope 受限只信任 skip clauses 没读 v7 plan body)。0 反驳。reviewer-claude ✅ scope 受限 与 reviewer-codex ❌ 真读 plan body 不一致 → 走 codex 修法(MED-1 + MED-2 + LOW)。**v8 Round 8 prompt 强制 claude 重读 plan body**(避免 scope 受限再次漏 finding)。

### Round 8 deep-review(2026-05-20)— 🎉 双方 ✅ 设计收口

**reviewer-claude Round 8**:✅ 收口 / 0 HIGH 0 真 MED + 1 INFO(非阻断 — buildAdoptedTeamsContextBlock helper 模块位置未明)— **Round 7 false ✅ 教训纠正**:Round 8 直读 v8 plan body 全文 762 行(分 3 段 Read 因 71.7KB 撞 25000 token limit)+ 复读 spike1+2 v2,Focus 4 维度逐一验证全过 + 无新 finding。
**reviewer-codex Round 8**:✅ 设计收口 / 0 HIGH 0 真 MED + 1 LOW(顺手 — 文档残留:总目标 line 21 / D10 path list / §已知踩坑 v4/v5 旧 adopt prompt 描述)— Round 7 的 2 MED + 1 LOW 主体修订充分(newSid placeholder 已删 / adopt prompt 不再复用 spawn lead context / placeholder / partial adopt warning 已进 helper + T4.5/T6.X4),仅文档残留不阻塞设计正确性。

**v9 顺手清理**(Round 8 双方非阻断 LOW + INFO):
- 总目标 line 21 改写为 v8 单一语义("handler 拼 adopted teams context block",删 wire prefix 旧描述)
- D10 path list 加 `adopted-teams-context-block.ts` + `adopted-teams-context-block.test.ts`(adopt 路径独立 helper,与 v4 spawn 路径 `lead-context-block.ts` 解耦明示)
- §已知踩坑 重复 / v4-v7 历史 bullet 整合为 **D11 v8 final design 单一权威 bullet** + 删除重复 line 657-663
- claude INFO-1 模块位置:plan D10 + Phase 4 step 1d/e 已隐式决策 — adopt 路径 helper 走**独立模块** `adopted-teams-context-block.ts`(SSOT 边界比 co-locate spawn.ts 更清晰)

**Round 8 最终总结**:0 真 HIGH;0 真 MED;1 LOW(codex 顺手)+ 1 INFO(claude 非阻断)→ **🎉 设计骨架经 Round 1-8 八轮迭代完全稳固**。

| Round | finding 总数 | HIGH | MED | LOW/INFO | 修订版本 |
|---|---|---|---|---|---|
| Round 1 | 12 | 3 | 6 | 3 | v2 |
| Round 2 | 7 | 1 | 3 | 3 | v3 |
| Round 3 | 6 | 1 | 3 | 2 | v4 |
| Round 4 | 5 | 0 | 3 | 2 | v5 |
| Round 5 | 3 | 0 | 3 | 0 | v6 |
| Round 6 | 7 | 0 | 2 | 5 | v7 |
| Round 7 | 3 | 0 | 2 | 1 | v8 |
| Round 8 | 2 | 0 | 0 | 2 | **v9 (final)** |

设计核心稳固性:
- ✅ **N1 zero dual-lead window**(spike2 v2 实证 + N1 swapLead atomic transaction + archive 联动隔离 attestation)
- ✅ **DB invariant 守门**(N4 hard gate 1+2:keep_teammates grep == 0 + zod strict reject)
- ✅ **SSOT 唯一化**(spawn 路径 buildLeadContextBlock 抽 helper + adopt 路径 buildAdoptedTeamsContextBlock 独立 helper,边界清晰防漂移)
- ✅ **N5 ≥1 lead 硬约束 fail-fast + firstTeam fatal abort**(根治 stale anchor 防御不可执行 + caller 状态零变化承诺)
- ✅ **DB messages.body 不含 wire prefix invariant**(adopt 路径不写 placeholder 完全 bypass,无 orphan placeholder 残留)
- ✅ **adapter contract 兼容**(adopt 路径 spawn 不传 team_name + 不写 placeholder + 无 spawn 后 prompt mutation,与现有 spawn/adapter SDK 时序契约 100% 兼容)
- ✅ **partial adopt warning 文档化 + 测试守门**(prompt 标 "attempted" + verify shared membership + T4.5/T6.X4 字串守门)
