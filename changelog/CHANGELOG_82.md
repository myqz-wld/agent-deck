# CHANGELOG_82

## 拆 agent-deck-team-repo.ts 658 → agent-deck-team-repo/ 5 文件（plan deep-review-and-split-20260513 Phase 2 Step 2.2）

## 概要

`src/main/store/agent-deck-team-repo.ts` 是 store 层第二大文件（H1 fix 后涨到 658 行，加了
archive_reason 列处理 + 各 SQL 联表 sessions 校验注释）。本次按 plan §步骤 checklist
Phase 2 Step 2.2 拆为 `agent-deck-team-repo/` 目录 5 文件，每个 ≤ 220 行。typecheck 双端通过。

外部 caller import 路径不变（`from '@main/store/agent-deck-team-repo'` 自动 resolve 到
`agent-deck-team-repo/index.ts`）。

## 变更内容

### 拆分（src/main/store/agent-deck-team-repo.ts → src/main/store/agent-deck-team-repo/）

- `agent-deck-team-repo/index.ts` (130 行) — facade `createAgentDeckTeamRepo` + `agentDeckTeamRepo`
  懒拿 default repo + `AgentDeckTeamRepo` interface（19 method surface），re-export
  `TeamInvariantError` / `TeamNotFoundError` / `AddMemberInput` / `CreateTeamInput` /
  `ListTeamsOptions` 保持外部 caller import 一处覆盖所有 surface。
- `agent-deck-team-repo/types.ts` (139 行) — `TeamRow` / `MemberRow` SQLite shape +
  `teamRowToRecord` / `memberRowToRecord` 转换 + `CreateTeamInput` / `AddMemberInput` /
  `ListTeamsOptions` interface + `MAX_LEADS_PER_TEAM` 常量 + 2 错误类。无 sibling 依赖，
  其他 sub-module 共享 import。
- `agent-deck-team-repo/team-crud.ts` (211 行) — 9 个 team-side 操作：`create` /
  `ensureByName` / `get` / `getByActiveName` / `getWithMembers` / `list` / `archive` /
  `unarchive` / `hardDelete`。`getWithMembers` 注入 `memberQuery.listAllMembers` 反查
  members 列表。
- `agent-deck-team-repo/member-crud.ts` (181 行) — 3 个 member-side 写操作：`addMember` /
  `leaveTeam` / `setRole`。`addMember` 注入 `teamCrud.get` 校验 team 存在 + 注入
  `memberQuery.countActiveLeads` 校验 lead 上限；`setRole` 同样需要 `countActiveLeads` +
  `listActiveMembers`。
- `agent-deck-team-repo/member-query.ts` (166 行) — 6 个 member-side 读操作（无副作用纯
  SELECT）：`listActiveMembers` / `listAllMembers` / `findActiveMembershipsBySession` /
  `findActiveMembershipsBySessionIds` / `findSharedActiveTeams` / `countActiveLeads`。
  无 sibling 依赖，是其他 sub-module 的根。

### Dependency DAG（拆分顺序保证）

```
member-query  (无依赖，纯 read SQL)
    ↑
team-crud     (依赖 member-query.listAllMembers)
    ↑
member-crud   (依赖 team-crud.get + member-query.countActiveLeads/listActiveMembers)
```

facade `createAgentDeckTeamRepo(db)` 按此 DAG 顺序构造三 sub-module，最后 spread merge
为统一 `AgentDeckTeamRepo` 实例。`agentDeckTeamRepo` 默认实例懒拿 `getDb()` 行为不变。

### 不修改业务行为

本拆分**仅文件物理拆分**，不修任何 SQL / 业务逻辑 / API surface：
- 19 method 签名 100% 一致
- 所有 SQL 字符串原样迁移（含 H1 加的 JOIN sessions 过滤 archived_at 等修法）
- `agentDeckTeamRepo` 默认实例方法名 / 参数顺序 100% 一致
- 错误类 / input/option 类型从 facade re-export，外部 import 路径零修改

## 测试

- `pnpm typecheck` 双端（node + web）通过
- 不跑 vitest（按 CLAUDE.md「跑 vitest SQLite 真测前后必须保护 better-sqlite3 binding」教训）

## 关联

- plan `~/.claude/plans/piped-fluttering-moth.md` Phase 2 Step 2.2
- CHANGELOG_81 (Step 2.1 拆 tools.ts) — 同 plan 同 Phase 上一步
