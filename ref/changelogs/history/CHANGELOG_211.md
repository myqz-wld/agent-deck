# CHANGELOG_211

## Team 页面 Add Member 入口

### 概要

TeamDetail 成员区新增加入成员入口，让应用约定里的“应用 -> Team 面板 -> Add Member”路径重新可执行。

### 变更内容

- `MembersSection` 增加“加入成员”表单：选择未归档且 `active/dormant` 的会话，选择 `协作者` 或 `负责人` 后调用既有 `addAgentDeckTeamMember` IPC。
- 新增 `selectJoinableTeamSessions` 纯 selector：排除当前 active member，保留 left member 的 rejoin 路径，排序复用 live session 口径。
- `TeamDetail` 在加入成功后主动刷新 team snapshot，同时继续依赖既有 team changed 事件做增量刷新。
- `agent-deck-team:add-member/remove-member` IPC 路径补齐 `notifyTeamMembershipChanged`，让被加入/移除会话的 team chip 与成员列表同步刷新。
- README Universal Team Backend 能力说明同步补上 Team tab 手动加入已有团队。

### 验证

- `pnpm exec vitest run src/renderer/components/TeamDetail/__tests__/member-candidates.test.ts`
- `pnpm typecheck`
