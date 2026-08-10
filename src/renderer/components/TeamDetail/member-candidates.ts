interface CandidateSession {
  id: string;
  lifecycle: string;
  archivedAt?: number | null;
  lastEventAt: number;
}

interface CandidateMember { sessionId: string; leftAt: number | null }

/**
 * TeamDetail Add Member 候选：当前 live 会话里排除仍 active 的 team member。
 * leftAt 非空的历史成员不排除，允许通过 addMember 的 rejoin 路径重新加入。
 */
export function selectJoinableTeamSessions<T extends CandidateSession>(
  sessions: ReadonlyMap<string, T>,
  members: CandidateMember[],
): T[] {
  const activeMemberSessionIds = new Set(
    members.filter((member) => member.leftAt === null).map((member) => member.sessionId),
  );

  return [...sessions.values()]
    .filter((session) => (
      (session.archivedAt === null || session.archivedAt === undefined) &&
      (session.lifecycle === 'active' || session.lifecycle === 'dormant')
    ))
    .filter((session) => !activeMemberSessionIds.has(session.id))
    .sort((left, right) => right.lastEventAt - left.lastEventAt);
}
