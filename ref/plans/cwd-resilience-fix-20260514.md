---
plan_id: "cwd-resilience-fix-20260514"
created_at: "2026-05-14"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/cwd-resilience-fix-20260514"
status: "completed"
base_commit: "22d90e8"
base_branch: "main"
final_commit: "010d33f2123c5abd89f8f464ee27535da2eafe19"
completed_at: "2026-05-14"
---
# cwd 失效根治:K2 default 改 mainRepo + archive_plan 归档 caller + recoverer 启发式 fallback

## 总目标 & 不变量

**目标**:根治「会话 cwd 指向已删目录」类 bug。具体表现:用户上一次 plan 收口后 (mcp-handoff-fix-and-skill-timer-20260514),会话 detail 发消息撞 `Path "..." does not exist` 弯绕错误链 (recoverer 乐观 emit「正在自动恢复」→ SDK 用 bad cwd spawn → CLI 报 Path 不存在 → 重试链路无意义)。

**触发**:用户给前一个会话 detail 的截图,cwd 指向被 archive_plan 删掉的 worktree 路径。诊断后定位到三层根因:
1. K2 `start-next-session.ts:143` default `cwd: args.cwd ?? resolved.worktreePath` —— 直接给新 SDK session 设 cwd = worktree path,破坏了「sessionRepo.cwd 不在 worktree 内」的隐形不变量 (EnterWorktree 模式下 sessionRepo.cwd 永远是创建时记录的 main repo,worktree 删了不影响)
2. `archive_plan` tool 不归档 caller —— plan 收口后 caller session 留 active,用户继续点开发消息就撞死 cwd
3. `recoverer.ts` 没有 cwd 存在性 precheck —— 与 jsonl missing 的 fallback 模式 (CHANGELOG_28) 不对称,bad cwd 直接传给 createSession 走弯绕链路

**不变量**(实施过程任何时候不能破):
1. EnterWorktree 模式下 sessionRepo.cwd 永远是「进 worktree 之前」的 cwd —— 这条保证不变,K2 改造也要让新 K2 session 的 sessionRepo.cwd 落到 main repo (与 EnterWorktree 模式对齐)
2. 数据完整性:cwd 失效场景下,应用层 events / file_changes / summaries 子表必须保留 (走 jsonl missing 同款 fallback 路径,renameSdkSession 把子表迁到新 sessionId)
3. archive_plan 归档 caller 是 default 行为(与 K2 baton CHANGELOG_97 同款),caller 仍可显式 override (用 `archive_caller: false` 参数)
4. recoverer 启发式 fallback 不能改变现有行为 —— 仅在 cwd 不存在时触发,其他路径走原 jsonl missing / 正常 resume 逻辑
5. K2 改 default 后 cold-start prompt 不变 —— 新 session 按 user CLAUDE.md §Step 3 已有的「cat plan + EnterWorktree(path: ...)」流程跑,不需要 K2 提前替它进 worktree

## 设计决策(不再争论)

### D1. K2 default cwd = mainRepo,双层 fallback

`start-next-session.ts:143`:`cwd: args.cwd ?? resolved.mainRepo ?? resolved.worktreePath`

- `args.cwd`:caller 显式传(test 场景 / 极少数想强制 worktree cwd 的边角)
- `resolved.mainRepo`:impl 计算的 main repo path(优先级见 D2)
- `resolved.worktreePath`:**最后兜底**(mainRepo 反查全部失败时退化到当前行为,保证不崩)

### D2. `mainRepo` 计算优先级

`start-next-session-impl.ts` 加 `mainRepo: string | null` 计算:

1. 优先 caller cwd → `git rev-parse --git-common-dir` 反查(impl 现有机制,A1 修复后可靠)
2. 反查失败 → 从 `worktreePath` 启发式反推:正则匹配 `^(.+)/\.claude/worktrees/[^/]+/?$` 取捕获组 1
3. 启发式失败 → null(handler 双层 fallback 兜底)

### D3. cold-start prompt 不变

不动 `按 <plan-abs-path> 接力(Phase: <label>)` 形态。新 session 按 user CLAUDE.md「§Step 3 cold start」已有流程跑:cat plan → 从 frontmatter 拿 worktree_path → `EnterWorktree(path: <worktree_path>)` → 看 §下一会话第一步。所以 K2 改 default 后新 session 行为与 EnterWorktree 模式对齐 —— sessionRepo.cwd = main repo,process.cwd 经 EnterWorktree 进 worktree 干活。

### D4. archive_plan default 归档 caller(与 K2 baton CHANGELOG_97 同款)

`archive-plan.ts` 在 ok return 前加:
- 反查 `caller.callerSessionId` 在 sessions 表的 row(防边界 case 探针)
- 调 `sessionManager.archive(callerSessionId)`
- ok return 加 `archived: 'ok' | 'failed' | 'skipped'` 三态字段

**不**加 `archive_caller: boolean` 参数 override(YAGNI;真有不归档需求 caller 可以归档后立即 unarchive,或在用户 UI 取消归档)。

### D5. recoverer cwd 启发式 fallback —— 走 jsonl missing 同款路径

`recoverer.ts` 在 `recoverAndSend` 入口取完 `rec` 之后,`text` 长度校验之前,加 cwd 存在性 precheck:

```ts
if (!existsSync(rec.cwd)) {
  const fallbackCwd = findFallbackCwd(rec.cwd);
  if (!fallbackCwd) {
    // 真没救,emit error message + throw
    return;
  }
  // 走 jsonl missing 同款 fallback 路径(createSession 不带 resume + 后置 rename)
  // 但 cwd 用 fallbackCwd 而不是 rec.cwd
  ...
}
```

`findFallbackCwd` 启发式:
1. 路径含 `/.claude/worktrees/` segment → 取之前的部分(main repo)
2. 否则 walk 父目录链找第一个还存在的目录(不超过 / 也不超过 home,避免逃逸到无意义路径)
3. 都不行 → null

**与 jsonl missing fallback 共享逻辑**:不写新分支,把 jsonl missing 路径里的 `cwd: rec.cwd` 改成 `cwd: effectiveCwd`,effectiveCwd 在 cwd-precheck 阶段确定。

### D6. UI 提示策略(可选,本 plan 不做)

不在 SessionDetail 加 「cwd 已自动 fallback」提示横幅 —— recoverer 已在事件流 emit 一条 message 说明 cwd 失效 + 用了哪个 fallback,detail 会自动渲染。本 plan 仅做 backend,UI 改动留给后续 changelog。

### D7. archive_plan 归档失败的处理

参考 K2 (`start-next-session.ts:174-204`) 同款:
- archive 抛错只 `console.warn` 不阻塞 ok return
- ok return `archived: 'failed'`(让 caller 感知)

### D8. setCwd 不做(K2 根治后无意义)

原方案 1 (archive_plan 完成后 setCwd → mainRepo) 取消。理由:K2 default 改 mainRepo 后,archive_plan caller 的 sessionRepo.cwd 一直是 main repo,setCwd 没事可做。

### D9. 老 K2 session(数据库里已 cwd = worktree 的)由 recoverer fallback 兜

不做数据迁移(不写脚本回填老 row 的 cwd),让 recoverer fallback 自然兜底。这些会话用户下次发消息时,recoverer 启发式找到 main repo,后续会话能继续工作。

### D10. 通用 hand-off 改造(用户反馈)

K2 当前强绑 plan + worktree,用户希望任意会话都能 baton 交给新 session。**方案 B**:让 `plan_id` 变 optional + 加 `prompt` 字段,impl 双模式分流。

- **plan-driven 模式**(`plan_id` 传):现有行为不变。default cwd = mainRepo(D1)
- **generic 模式**(`plan_id` 不传):
  - 不读 plan 文件 / 不要 worktree_path
  - cold-start prompt = `args.prompt ?? '从上一个会话接力继续工作'`
  - default cwd = caller cwd(从 sessionRepo 反查;handler 已有反查机制)
  - `phase_label` / `plan_file_path` / `cwd` 之外字段:caller 传也忽略 + impl warn

**ok return 字段**:
- plan 模式:保持当前(planId / planFilePath / worktreePath / baseBranch / phaseLabel / initialPrompt + spawn fields + archived)
- generic 模式:planId / planFilePath / worktreePath / baseBranch / phaseLabel = null;initialPrompt = 实际用的 prompt;新加 `mode: 'plan' | 'generic'` 字段标识

### D11. tool 改名 `start_next_session` → `hand_off_session`(用户反馈)

`start_next_session` "next" 暗示 plan 阶段,通用模式 misleading。改名 `hand_off_session` 与现有术语一致(user CLAUDE.md / app CLAUDE.md / changelog 已用 "hand-off" / "K1 hand-off automation" / "K2 hand-off automation")。

**rename 范围**:
- 2 个 ts 文件 rename:`start-next-session.ts` / `start-next-session-impl.ts` → `hand-off-session.ts` / `hand-off-session-impl.ts`
- 1 个 test 文件 rename:`start-next-session.test.ts` → `hand-off-session.test.ts`
- `AGENT_DECK_TOOL_NAMES.startNextSession` → `handOffSession`(value 'mcp__agent-deck__hand_off_session')
- handler / impl 所有 export name 同步(`startNextSessionHandler` → `handOffSessionHandler` 等)
- schema name `START_NEXT_SESSION_SCHEMA` → `HAND_OFF_SESSION_SCHEMA`
- 4 处文档引用全改 + tool description
- **changelog 历史不动**(保留 `start_next_session` 字样作历史记录)
- tool description 加一句 "(formerly known as `start_next_session`)" 升级过渡期可发现

## 步骤 checklist (5 phase × 多 step)

### Phase A — K2 default = mainRepo 根治

- [x] **A1. start-next-session-impl.ts 加 mainRepo 计算** — 单次 git rev-parse,plan 文件 fallback + handler default cwd 共享
- [x] **A2. start-next-session.ts handler 改默认 cwd** — `args.cwd ?? resolved.mainRepo ?? resolved.worktreePath` 双层 fallback
- [x] **A3. tools/schemas.ts + tools/index.ts K2 description 更新** — 说明 default cwd 改为 mainRepo
- [ ] **A4. 单测改造** — happy path mainRepo 字段 + 启发式 hit + 启发式 miss + override 路径仍调 git 1 次

### Phase A′ — 通用 hand-off 改造(D10 + D11)

- [ ] **A′1. rename 2 ts 文件 + 1 test 文件** — `start-next-session{,-impl,.test}.ts` → `hand-off-session{,-impl,.test}.ts`
- [ ] **A′2. AGENT_DECK_TOOL_NAMES + schema/handler/impl/test 内所有 export name rename** — 同步保持引用一致
- [ ] **A′3. schema 双模式改造** — `plan_id` 变 optional + 新增 `prompt` optional 字段(generic 模式 cold-start)
- [ ] **A′4. impl 双模式分流** — 有 plan_id 走 plan-driven 现有逻辑;无 plan_id 走 generic(不读 plan / cold-start = args.prompt ?? '从上一个会话接力继续工作' / mainRepo 仍计算给 plan 模式用)
- [ ] **A′5. handler 双模式 default cwd** — plan: `args.cwd ?? mainRepo ?? worktreePath`;generic: `args.cwd ?? callerSessionRow.cwd ?? mainRepo`
- [ ] **A′6. ok return 加 `mode: 'plan' | 'generic'` 字段** — generic 模式下 planId/planFilePath/worktreePath/baseBranch/phaseLabel 全 null
- [ ] **A′7. 单测加 generic 模式 happy path + 边界 case**

### Phase B — archive_plan default 归档 caller

- [ ] **B1. archive-plan.ts handler 加 archive caller** — 复制 K2 模式
- [ ] **B2. ok return 加 archived 字段**(三态 ok/failed/skipped)
- [ ] **B3. tools/schemas.ts + tools/index.ts archive_plan description 更新**
- [ ] **B4. 单测**(happy / row missing / external sentinel / archive 抛错)

### Phase C — recoverer cwd 启发式 fallback

- [ ] **C1. recoverer.ts 加 findFallbackCwd helper**
- [ ] **C2. recoverAndSend 加 cwd precheck + effectiveCwd 改造**
- [ ] **C3. 单测**(cwd 存在 / 启发式 1 命中 / 启发式 2 命中 / 全 miss)

### Phase D — 4 处文档同步(D11 配套 + 双模式 + cwd resilience + archive caller)

- [ ] **D1. resources/claude-config/CLAUDE.md** — K2 节改名 + 双模式说明 + archive caller 默认 + cwd resilience
- [ ] **D2. resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md** — `start_next_session` → `hand_off_session` 引用同步
- [ ] **D3. docs/agent-deck-mcp-protocol.md** — stub 引用同步
- [ ] **D4. ~/.claude/CLAUDE.md** — §Step 3 选项 B / §Step 2.5 hand off 触发节 tool 名字同步

### Phase E — 双异构对抗 review(deep-code-review SKILL)

- [ ] **E1. spawn 双 reviewer teammate**
- [ ] **E2. R1 双对抗 + 三态裁决 + 修真问题 → R2 验证 → R3 收口**
- [ ] **E3. shutdown reviewer**

### Phase F — 收口

- [ ] **F1. typecheck + build smoke**
- [ ] **F2. 写 CHANGELOG_99.md + 同步 changelog/INDEX.md**
- [ ] **F3. commit changelog**
- [ ] **F4. ExitWorktree(action: "keep") + mcp__agent-deck__archive_plan**

## 当前进度

- ✅ 已完成 Step 0:EnterWorktree + 写 plan 文件
- ✅ Phase A1/A2/A3:K2 cwd default = mainRepo 根治(impl + handler + 2 处 description)
- ⏳ 当前:Phase A4 单测改一半(happy path / override 路径已改;启发式 hit / miss 新 case 已加)
- ⏳ 用户反馈插入:Phase A′ 通用 hand-off 改造(plan_id 变 optional + 加 prompt 字段) + tool rename `start_next_session` → `hand_off_session`
- ⏳ 下一步:收尾 Phase A4 单测 → Phase A′ rename → Phase A′ 双模式 → Phase B/C/D/E/F

## 下一会话第一步

按 plan 进入 worktree(`EnterWorktree(path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/cwd-resilience-fix-20260514")`) → 找 plan checklist 下一个未勾 step → 直接动手。

**当前接力点(若上一会话刚完成 A1/A2/A3)**:
1. 收尾 **A4** 单测:已改 happy path mainRepo 字段 + 启发式 hit + 启发式 miss + override 路径 git 1 次。剩余需要快速 `pnpm exec vitest run start-next-session.test.ts` 跑一次确认全过。
2. 接 **A′1**:rename 2 ts + 1 test 文件:
   ```
   git mv src/main/agent-deck-mcp/tools/handlers/start-next-session.ts             → hand-off-session.ts
   git mv src/main/agent-deck-mcp/tools/handlers/start-next-session-impl.ts        → hand-off-session-impl.ts
   git mv src/main/agent-deck-mcp/__tests__/start-next-session.test.ts             → hand-off-session.test.ts
   ```
3. **A′2**:`AGENT_DECK_TOOL_NAMES.startNextSession` → `handOffSession` (value `'mcp__agent-deck__hand_off_session'`);所有 export rename(`startNextSessionHandler` → `handOffSessionHandler` / `startNextSessionImpl` → `handOffSessionImpl` / `START_NEXT_SESSION_SCHEMA` → `HAND_OFF_SESSION_SCHEMA` 等);test 内 import / handler 调用全改
4. **A′3**:`HAND_OFF_SESSION_SCHEMA` 改 `plan_id` 为 `.optional()`,加 `prompt: z.string().optional().describe(...)` 字段
5. **A′4**:impl 主流程改成「有 plan_id 走 plan-driven / 无 plan_id 走 generic(不读 plan)」分流
6. **A′5**:handler 改 `cwd: args.cwd ?? (input.planId ? resolved.mainRepo ?? resolved.worktreePath : callerCwd ?? resolved.mainRepo)`
7. **A′6/A′7**:ok return 加 mode 字段 + generic 模式新单测 case(happy / args.prompt 空 / phase_label 在 generic 下被忽略 + warn)
8. **Phase B-F** 按原计划

**所有指向代码资产的路径必须用 worktree 内绝对路径**:
- 代码:`/Users/apple/Repository/personal/agent-deck/.claude/worktrees/cwd-resilience-fix-20260514/src/main/agent-deck-mcp/...`
- 文档:`<worktree>/resources/claude-config/...`
- changelog:`<worktree>/changelog/...`

**例外**(plan 文件本身不在 worktree):
- plan: `/Users/apple/Repository/personal/agent-deck/.claude/plans/cwd-resilience-fix-20260514.md`
- user CLAUDE.md(D4 改): `/Users/apple/.claude/CLAUDE.md`

## 已知踩坑

- 「sessionRepo.cwd 永远不更新」是应用层不变量(只在 INSERT 写一次 / rename 时迁过去),改 cwd 字段必须走非常审慎的路径(本 plan 不动这个不变量,只做 fallback)
- recoverer 已有 jsonl missing fallback (CHANGELOG_28),cwd fallback 应当复用同款下游路径(createThunk 不带 resume + renameSdkSession),不能开新分支
- archive_plan 归档失败仅 warn 不阻塞,与 K2 baton CHANGELOG_97 同款
- worktree HEAD 起手 = 5db9844(K2 baton 改造),已 ff merge 到 main 22d90e8 后开始
