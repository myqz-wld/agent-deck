---
plan_id: "hand-off-mcp-archive-opt-20260515"
created_at: "2026-05-15"
worktree_path: "/Users/apple/Repository/personal/agent-deck/.claude/worktrees/hand-off-mcp-archive-opt-20260515"
status: "completed"
base_commit: "d635dad"
base_branch: "main"
parent_review_id: "REVIEW_40"
final_commit: "c5f6d9c9021d22ece2fb0c67633e64fcf785eac7"
completed_at: "2026-05-15"
---
# hand-off-mcp-archive-opt-20260515 — hand_off_session mcp tool 加 archive_caller 选项让 caller 可选不归档

## 总目标 & 不变量

用户主动提的 follow-up:`hand_off_session` mcp tool 当前**强制 archive caller**(baton 单向交接语义),不灵活。某些场景下 caller 仅想起新 session 并行做事(spawn 用法),不想被自己 archive。

**用例**:
- caller 想起多个 hand-off 处理 follow-up 子任务,自己 still alive 协调进度(典型:本会话 hand-off P0/P1/P2 但本会话仍想看 reviewer reply / 出 summary)
- 单元测试 / debug 工具想起新 session 实测某 plan 但 caller 自己还要继续观察
- 其他 cross-cutting 用法:caller 起 child session 处理子任务,主 caller 仍是主导

**修法**:
1. `agent-deck-mcp/tools/schemas.ts` HAND_OFF_SESSION_SCHEMA 加 `archive_caller?: z.boolean().default(true)` 字段
2. `agent-deck-mcp/tools/handlers/hand-off-session.ts` 透传 args.archive_caller 给 impl
3. `agent-deck-mcp/tools/handlers/hand-off-session-impl.ts` 内 caller archive helper 加判断 — `archive_caller === false` 跳过 archive(同款逻辑给 keep_teammates 已有)
4. 同步 jsdoc + tool description 说明新行为(默认 true 保持兼容性)
5. 加 regression test:`archive_caller: false` 场景验证 caller 不被 archive

**不变量**:
- 默认 `archive_caller: true`(保持当前 baton 语义,向后兼容)
- 仅当 caller 显式传 `archive_caller: false` 跳 archive
- 行为变化(新 schema 字段 + handler 分支),需充分 test
- 与 keep_teammates 字段语义对称(都是「baton 默认动作」可 opt-out)
- typecheck 双端 + 全套 vitest + 新加 test 必跑

## 设计决策(不再争论)

### 1. 字段命名:`archive_caller` 不是 `keep_caller`

与 `keep_teammates` 对称命名风格(都是 boolean,描述「是否做某动作」):
- `keep_teammates: false` 默认 → "shutdown teammates"
- `archive_caller: true` 默认 → "archive caller"

字段命名直接表达「会做什么动作」+ 默认值 + boolean opt-out 语义。

**否决方案**:`keep_caller` — 与 `keep_teammates` 看似对称但语义反向(`keep_caller: true` 默认 = 不归档,与当前 baton 默认 archive 行为不一致 + 默认值反直觉)。

### 2. impl 层 caller archive 逻辑位置

当前 `hand-off-session-impl.ts` 内 archive caller 是 `await archiveCallerSession(callerSid)` 一处调用。改成:

```ts
if (archiveCaller) {
  await archiveCallerSession(callerSid);
}
// else 跳过,caller 仍 active
```

不复杂,~3 行加 if 判断 + 1 行透传参数。

### 3. ok return 字段是否需要新增

当前 hand_off_session ok return 含 `archived` 三态字段(caller archive 结果)。`archive_caller: false` 时 archived 应是什么?

**推荐**:加新值 `'skipped'`(与 keep_teammates 同款 `skipped` 语义)。schema 改:

```ts
archived: z.enum(['ok', 'failed', 'skipped'])
```

`'skipped'` = 因 `archive_caller: false` 显式跳过(与 `'failed'` warn-only 不同,是用户意图)。

### 4. tool description 同步

mcp tool description SSOT 在 schemas.ts,改 schema 时 description 同步更新:
- 加段说明 `archive_caller` 字段的默认行为 + opt-out 用例
- 与 `keep_teammates` 字段说明在一起,强调「baton 默认动作可 opt-out」

### 5. test 范围

加 2-3 case:
- `archive_caller: false` → caller 不被 archive(sessionRepo.get 后查 lifecycle ≠ archived + ok return.archived === 'skipped')
- `archive_caller: true` (默认) → 同当前行为
- `archive_caller: undefined`(不传) → default true,同 archive 行为

## 步骤 checklist

### Phase 1: schema + handler

- [x] **Step 1.1 — schema**:`agent-deck-mcp/tools/schemas.ts` HAND_OFF_SESSION_SCHEMA 加 `archive_caller?: boolean default(true)` + tool description 段更新 + ok return `archived` enum 加 `'skipped'` — done by hand-off-mcp-archive-opt session on 2026-05-15, commit c5f6d9c
- [x] **Step 1.2 — handler 透传**:`hand-off-session.ts` 透传 args.archive_caller 给 impl — done in same commit c5f6d9c (透传给 runBatonCleanup helper input.archiveCaller 而非 impl,因 impl 不涉及 archive caller)
- [x] **Step 1.3 — impl 加判断**:`hand-off-session-impl.ts` archive caller 包 `if (archiveCaller) {...} else { archived = 'skipped' }` — done in same commit c5f6d9c (实际改在 baton-cleanup.ts helper 而非 impl,因 archive caller 在 helper 内统一)

### Phase 2: test

- [x] **Step 2.1 — regression test**:加 5 case (baton-cleanup case 11+12 + hand-off-session.handler-deny-happy archive_caller opt-out describe 3 case 含正交两字段同时启用) — done in same commit c5f6d9c

### Phase 3: 收口

- [x] **Step 3.1 — 跑 vitest**:typecheck 双端 0 错 + vitest 全套 39 文件 / 531 测 0 regression — done in same commit c5f6d9c
- [x] **Step 3.2 — CHANGELOG_114.md**:简洁概要 schema 字段加 + handler 分支 + ok return 三态扩 + 同步 INDEX.md — done in same commit c5f6d9c
- [ ] **Step 3.3 — archive_plan**:`mcp__agent-deck__archive_plan` 自动归档(前置 ExitWorktree(action: "keep"))

## 当前进度

- ✅ Step 1.1+1.2+1.3 (schema + handler + helper) — commit c5f6d9c
- ✅ Step 2.1 (5 regression test) — commit c5f6d9c
- ✅ Step 3.1 (typecheck + vitest) — 0 regression
- ✅ Step 3.2 (CHANGELOG_114) — commit c5f6d9c
- ⏳ Step 3.3 (archive_plan) — 进行中,即将 ExitWorktree + 调 archive_plan

## 下一会话第一步

按 user CLAUDE.md cold-start 流程:

1. `Bash: cat /Users/apple/Repository/personal/agent-deck/.claude/plans/hand-off-mcp-archive-opt-20260515.md` 全文读 plan
2. `EnterWorktree(name: "hand-off-mcp-archive-opt-20260515")` 创建新 worktree
3. `git log --oneline -5` 自检 HEAD = d635dad(base_commit)或之后
4. **从 Step 1.1 开始动手**:
   - 读 `agent-deck-mcp/tools/schemas.ts` HAND_OFF_SESSION_SCHEMA + tool description 块
   - 读 `hand-off-session.ts` + `hand-off-session-impl.ts` 看 caller archive 调用点
   - 改 schema + handler + impl + regression test
5. 改完每步跑 `pnpm typecheck` + 影响范围内的 vitest;commit message 必须含「(handoff-archive-opt-plan P<X> Step Y.Z)」
6. 进度变更先告诉用户征得确认(autonomous mode 下 trivial 决策不需要,真歧义才停)

⚠️ **跨会话第一次读 plan 必须用 `Bash: cat` 而非 `Read` 工具**

## 已知踩坑

- **archive_plan 前置必须先 ExitWorktree**(CLI 内部 tool 限制)
- **base_branch 是 main**(本 plan 切 worktree 时主仓库 HEAD 在 main)
- **schema 改动同步 description**(mcp tool description SSOT 在 schemas.ts)
- **ok return.archived enum 扩 'skipped' 影响下游**:caller / test / 文档检查所有 archived 分支处理

## 相关 follow-up(本 plan 不做)

- **#6 codex sdk-bridge tests + #5 double rename cleanup**:留 plan `codex-sdk-bridge-tests-20260515`(P0 hand-off)
- **#7 extraAllowWrite + #4 recoverer waiter**:留 plan `cross-adapter-parity-20260515`(P1 hand-off)
- **#1 P4 BaseAdapter / #3 跨 adapter sandbox / #2 scheduler 命名**:留 plan `adapter-architecture-design-20260515`(P2 design,后续推进)

## 会话风格授权(autonomous mode)

承袭 REVIEW_40 plan「会话风格授权」:lead 自主推进 plan checklist,真歧义才停问用户。

**触发用户介入的真歧义清单**:
- plan 设计决策外的二选一
- 测试失败疑似真 bug 而非平移引起的预期 diff
- 用户对话中显式新指令(中断 autonomous 切回 user-driven)
- 安全 / 数据可逆性高风险操作
