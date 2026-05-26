# CHANGELOG_76: spawn_session 加 agent_name 自动注入 + projectSession 反查 lead teamName

## 概要

`mcp__agent_deck__spawn_session` schema 加可选字段 `agent_name`，非空时按 plugin agents registry resolve body file（`bundled-assets.getBundledAssetContent('agent', name)`）自动拼到 `prompt` 头部，免去 lead 自己 cat agent body 拼字符串（plan deep-review-flow-fix D1）。同时修「lead session spawn_session 后自身 teamName 仍 null」不对称 bug：`projectSession`（list_sessions / get_session 共用 projector）从 universal team backend `findActiveMembershipsBySession` 反查投影 teamName，老 `sessions.team_name` 列做 fallback（plan D3）。D2 `inherit_caller_permissions` 调研发现 SDK 仅有粗粒度 `allowedTools: string[]`、per-session settings overlay 跨 SDK + adapter 内部成本超预期，留 follow-up。D4 wait_reply 区分 finished/waiting-for-user 因 A.2 Step 2.5 cold-start 探测已应用层兜底，留 follow-up。

## 变更内容

### main/agent-deck-mcp (`src/main/agent-deck-mcp/tools.ts`)

- **D1**: SPAWN_SESSION_SCHEMA 加 `agent_name?: string`（zod regex `[a-zA-Z0-9._-]+` 限合法 plugin agent 名，max 128）
- **D1**: spawn_session handler 在 `applySpawnGuards` 后、`adapter.createSession` 前插入「`args.agent_name` 非空 → 调 `getBundledAssetContent('agent', name)` → 找不到立即 err（不 fallback 到裸 prompt 防静默落空）→ 拼接 `${body}\n\n---\n\n${args.prompt}`」流程
- **D3**: `projectSession` 改成「先调 `agentDeckTeamRepo.findActiveMembershipsBySession(sid)` → 多 team 取第一个 active → `agentDeckTeamRepo.get(teamId).name` → fallback 到 `s.teamName ?? null`」
- 新加 `import { getBundledAssetContent } from '@main/bundled-assets'`

### test (`src/main/agent-deck-mcp/__tests__/tools.test.ts`)

- 加 `createSessionCalls: Array<{ adapter; cwd; prompt?; teamName? }>` spy + beforeEach 清；扩展 createSession mock 收 `prompt` 字段
- 加 `mockMembershipsBySession` + `mockTeamsById` stateful Map，让 D3 测试动态注入「session → active memberships → team name」
- 加 `vi.mock('@main/bundled-assets')` 提供 `reviewer-claude` 假 body / 其他名 null
- 新增 5 个测试：D1 `agent_name auto-prepends body to prompt` / `agent_name unresolved → err` / `agent_name omitted → unchanged` + D3 `lead teamName from universal team backend` / `falls back to sessions.team_name when no membership`
- 33 tests 全过（+ spawn-guards 8 + wait-reply-coordinator 13 = 54 全过）

### plugin SKILL doc (`resources/claude-config/agent-deck-plugin/skills/deep-code-review/SKILL.md`)

- Step 1「Prompt 注入两种形态」更新：原「未来 (B 阶段实现后) 才有 agent_name」改为「现在 (B 阶段 D1 已实施) 推荐 agent_name；嵌 body 仍可用作兼容路径」
- Step 0.6「选项 B」标 D2 仍是 follow-up（`inherit_caller_permissions` 未实施；继续走选项 A 「~/.claude/settings.json 全局加 Bash(zsh:*)」或选项 C 「双 Bash 兜底」）

## 备注

- 关联 plan：[`.claude/plans/deep-review-flow-fix-20260512.md`](../.claude/plans/deep-review-flow-fix-20260512.md) Phase B
- D2 follow-up：SDK API `allowedTools: string[]` 是粗粒度（如 `["Bash", "Read"]`），不能透传 `Bash(zsh:*)` 这种细粒度模式；要做有意义的 D2 需要 per-session settings overlay（拦截 settings 注入 / 临时 settings.json / 让 teammate 用临时 settings 而不是用户 user scope），跨 ClaudeCodeAdapter / SDK 内部 / settings 三层。当前 reviewer-codex teammate 已天然走 user scope `~/.claude/settings.json` (settingSources: user/project/local)，用户在 settings.json 加白名单已能解决 99% 痛点
- D4 follow-up：`wait_reply` `until: 'turn_complete'` 当前实现包含 `waiting-for-user` event；改为只 `finished` 是 breaking change，影响 SKILL.md 全部 `until: 'turn_complete'` 调用。A.2 Step 2.5 cold-start 30s 探测已应用层兜底（卡审批时 lead 主动探活而非傻等 600s timeout）
- 性能：projectSession N+1 反查（list 默认 limit 50 → 50 次 indexed query）< 10ms 可接受，未优化批量 batch
- 改 main 后必须 dev 实测才生效（项目 CLAUDE.md 「验证流程」节硬约束）
