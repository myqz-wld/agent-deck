import { describe, expect, it } from 'vitest';
import type { AgentDeckTeamMember, SessionRecord } from '@shared/types';
import { selectJoinableTeamSessions } from '../member-candidates';

function makeSession(overrides: Partial<SessionRecord> & { id: string }): SessionRecord {
  const { id, ...rest } = overrides;
  return {
    id,
    agentId: overrides.agentId ?? 'claude-code',
    cwd: overrides.cwd ?? '/repo',
    title: overrides.title ?? id,
    source: overrides.source ?? 'sdk',
    lifecycle: overrides.lifecycle ?? 'active',
    activity: overrides.activity ?? 'idle',
    startedAt: overrides.startedAt ?? 1,
    lastEventAt: overrides.lastEventAt ?? 1,
    endedAt: overrides.endedAt ?? null,
    archivedAt: overrides.archivedAt ?? null,
    ...rest,
  };
}

function makeMember(
  overrides: Partial<AgentDeckTeamMember> & { sessionId: string },
): AgentDeckTeamMember {
  return {
    teamId: overrides.teamId ?? 'team-1',
    sessionId: overrides.sessionId,
    role: overrides.role ?? 'teammate',
    displayName: overrides.displayName ?? null,
    joinedAt: overrides.joinedAt ?? 1,
    leftAt: overrides.leftAt ?? null,
  };
}

describe('selectJoinableTeamSessions', () => {
  it('排除当前 active member，但允许 left member 重新加入', () => {
    const sessions = new Map(
      [
        makeSession({ id: 'lead', lastEventAt: 30 }),
        makeSession({ id: 'left-member', lastEventAt: 20 }),
        makeSession({ id: 'free', lastEventAt: 10 }),
      ].map((session) => [session.id, session]),
    );
    const members = [
      makeMember({ sessionId: 'lead', role: 'lead' }),
      makeMember({ sessionId: 'left-member', leftAt: 100 }),
    ];

    expect(selectJoinableTeamSessions(sessions, members).map((session) => session.id)).toEqual([
      'left-member',
      'free',
    ]);
  });

  it('只返回未归档的 active/dormant 会话并按最近活跃排序', () => {
    const sessions = new Map(
      [
        makeSession({ id: 'old-active', lifecycle: 'active', lastEventAt: 10 }),
        makeSession({ id: 'new-dormant', lifecycle: 'dormant', lastEventAt: 50 }),
        makeSession({ id: 'closed', lifecycle: 'closed', lastEventAt: 60 }),
        makeSession({ id: 'archived', archivedAt: 1, lastEventAt: 70 }),
      ].map((session) => [session.id, session]),
    );

    expect(selectJoinableTeamSessions(sessions, []).map((session) => session.id)).toEqual([
      'new-dormant',
      'old-active',
    ]);
  });
});
