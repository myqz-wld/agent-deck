/**
 * R3.E6 (PR-B) — 老 team 类型全删（TeamMember / TeamConfig / TeamSnapshot / TeamSummary /
 * TeamDataChangedEvent / TeamTaskPayload / TeamTeammateIdlePayload）。
 *
 * 新 universal team backend 类型在 `./agent-deck-team.ts`：AgentDeckTeam /
 * AgentDeckTeamMember / AgentDeckMessage 等。barrel `../types.ts` 已 re-export。
 *
 * 本文件保留只是为了不破坏 import 链；下次大版本（v012）整文件删除。
 *
 * 详 docs/agent-deck-team-protocol.md §6.2。
 */

// Intentionally empty.
export {};
