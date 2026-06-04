import type { AgentDeckTeamMember, SessionRecord } from '@shared/types';
import { selectLiveSessions } from '@renderer/lib/session-selectors';

/**
 * TeamDetail Add Member 候选：当前 live 会话里排除仍 active 的 team member。
 * leftAt 非空的历史成员不排除，允许通过 addMember 的 rejoin 路径重新加入。
 */
export function selectJoinableTeamSessions(
  sessions: Map<string, SessionRecord>,
  members: AgentDeckTeamMember[],
): SessionRecord[] {
  const activeMemberSessionIds = new Set(
    members.filter((member) => member.leftAt === null).map((member) => member.sessionId),
  );

  return selectLiveSessions(sessions).filter(
    (session) => !activeMemberSessionIds.has(session.id),
  );
}
