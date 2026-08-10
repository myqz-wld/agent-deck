import { describe, expect, it } from 'vitest';

import {
  parseTeamAddMemberResult,
  parseTeamAddMemberParams,
  parseTeamGetResult,
  parseTeamListParams,
  parseTeamListResult,
  parseTeamMutationResult,
  parseTeamShutdownResult,
  TEAM_LIST_MAX_ITEMS,
} from './teams';

const summary = {
  id: 'team-a',
  name: 'Remote reviewers',
  createdAt: 1,
  archivedAt: null,
  memberCount: 1,
  lastEventAt: 2,
} as const;

function detail() {
  return {
    id: 'team-a',
    name: 'Remote reviewers',
    createdAt: 1,
    archivedAt: null,
    archiveReason: null,
    members: [{
      teamId: 'team-a', sessionId: 'session-a', role: 'lead', displayName: null,
      joinedAt: 1, leftAt: null,
    }],
    sessions: [{
      id: 'session-a', adapterId: 'codex-cli', title: 'Lead', lifecycle: 'active',
      lastEventAt: 2, archivedAt: null, spawnedBy: null,
    }],
    pending: [{
      sessionId: 'session-a', permissions: 1, questions: 2, plans: 3, diffs: 4, total: 10,
    }],
    recentEvents: [],
    tasks: [],
    recentMessages: [],
  } as const;
}

describe('Remote team contracts', () => {
  it('accepts exact bounded list, detail, and member inputs', () => {
    expect(parseTeamListParams({ includeArchived: false, limit: 50 }))
      .toEqual({ includeArchived: false, limit: 50 });
    expect(parseTeamListResult({ teams: [summary], revision: 7 }, 50))
      .toEqual({ teams: [summary], revision: 7 });
    expect(parseTeamGetResult({ team: detail(), revision: 7 }))
      .toMatchObject({ team: { id: 'team-a', pending: [{ total: 10 }] }, revision: 7 });
    expect(parseTeamAddMemberParams({
      teamId: 'team-a', sessionId: 'session-b', role: 'teammate',
    })).toEqual({ teamId: 'team-a', sessionId: 'session-b', role: 'teammate' });
  });

  it('rejects zero/excessive limits, duplicate teams, and unexpected fields', () => {
    expect(() => parseTeamListParams({ includeArchived: false, limit: 0 })).toThrow();
    expect(() => parseTeamListParams({
      includeArchived: false, limit: TEAM_LIST_MAX_ITEMS + 1,
    })).toThrow();
    expect(() => parseTeamListResult({ teams: [summary, summary], revision: 7 }, 50)).toThrow();
    expect(() => parseTeamListResult({
      teams: [{ ...summary, archivedAt: 3 }], revision: 7,
    }, 50, false)).toThrow();
    expect(() => parseTeamListResult({
      teams: [{ ...summary, hostPath: '/private/core' }], revision: 7,
    }, 50)).toThrow();
  });

  it('binds targeted responses to the requested team, session, and role', () => {
    expect(() => parseTeamGetResult({ team: detail(), revision: 7 }, 'team-other')).toThrow();
    expect(() => parseTeamMutationResult({ team: summary, revision: 7 }, 'team-other'))
      .toThrow();
    expect(() => parseTeamMutationResult({ team: null, revision: 7 }, 'team-a')).toThrow();
    expect(() => parseTeamAddMemberResult({
      member: detail().members[0], revision: 7,
    }, { teamId: 'team-a', sessionId: 'session-a', role: 'teammate' })).toThrow();
  });

  it('binds nested members and pending totals to projected sessions', () => {
    expect(() => parseTeamGetResult({
      team: {
        ...detail(),
        members: [{ ...detail().members[0], sessionId: 'session-other' }],
      },
      revision: 7,
    })).toThrow();
    expect(() => parseTeamGetResult({
      team: {
        ...detail(),
        pending: [{ ...detail().pending[0], total: 11 }],
      },
      revision: 7,
    })).toThrow();
  });

  it('rejects duplicate nested identities and cross-team rows', () => {
    expect(() => parseTeamGetResult({
      team: { ...detail(), sessions: [detail().sessions[0], detail().sessions[0]] },
      revision: 7,
    })).toThrow();
    expect(() => parseTeamGetResult({
      team: { ...detail(), members: [detail().members[0], detail().members[0]] },
      revision: 7,
    })).toThrow();
    expect(() => parseTeamGetResult({
      team: {
        ...detail(),
        members: [{ ...detail().members[0], teamId: 'team-other' }],
      },
      revision: 7,
    })).toThrow();
    expect(() => parseTeamGetResult({
      team: { ...detail(), pending: [detail().pending[0], detail().pending[0]] },
      revision: 7,
    })).toThrow();
  });

  it('binds events and tasks while retaining messages from deleted sessions', () => {
    const event = {
      id: 1,
      sessionId: 'session-a',
      agentId: 'codex-cli',
      kind: 'message',
      payload: { text: 'done' },
      ts: 2,
    } as const;
    const task = {
      id: 'task-a',
      ownerSessionId: 'session-a',
      teamId: 'team-a',
      subject: 'Review',
      description: null,
      status: 'active',
      activeForm: null,
      priority: 5,
      blocks: [],
      blockedBy: [],
      labels: [],
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    } as const;
    expect(parseTeamGetResult({
      team: {
        ...detail(),
        recentMessages: [{
          id: 'message-a',
          fromSessionId: 'deleted-sender',
          toSessionId: 'deleted-recipient',
          body: 'retained history',
          status: 'delivered',
          statusReason: null,
          sentAt: 3,
          replyToMessageId: null,
        }],
      },
      revision: 7,
    })).toMatchObject({ team: { recentMessages: [{ id: 'message-a' }] } });
    expect(() => parseTeamGetResult({
      team: { ...detail(), recentEvents: [{ ...event, sessionId: 'session-other' }] },
      revision: 7,
    })).toThrow();
    expect(() => parseTeamGetResult({
      team: { ...detail(), tasks: [{ ...task, teamId: 'team-other' }] },
      revision: 7,
    })).toThrow();
    expect(() => parseTeamGetResult({
      team: { ...detail(), tasks: [{ ...task, ownerSessionId: 'session-other' }] },
      revision: 7,
    })).toThrow();
  });

  it('rejects duplicate event and message identities', () => {
    const event = {
      id: 1,
      sessionId: 'session-a',
      agentId: 'codex-cli',
      kind: 'message',
      payload: null,
      ts: 2,
    } as const;
    const message = {
      id: 'message-a',
      fromSessionId: 'session-a',
      toSessionId: 'deleted-recipient',
      body: 'hello',
      status: 'delivered',
      statusReason: null,
      sentAt: 3,
      replyToMessageId: null,
    } as const;
    expect(() => parseTeamGetResult({
      team: { ...detail(), recentEvents: [event, event] },
      revision: 7,
    })).toThrow();
    expect(() => parseTeamGetResult({
      team: { ...detail(), recentMessages: [message, message] },
      revision: 7,
    })).toThrow();
  });

  it('accepts only exact bounded teammate shutdown outcomes', () => {
    expect(parseTeamShutdownResult({
      closed: ['session-a'],
      failed: [{ sessionId: 'session-b', reason: 'Session could not be closed' }],
      revision: 8,
    })).toMatchObject({ closed: ['session-a'], revision: 8 });
    expect(() => parseTeamShutdownResult({
      closed: ['session-a'], failed: [], revision: 8, leaked: true,
    })).toThrow();
    expect(() => parseTeamShutdownResult({
      closed: ['session-a', 'session-a'], failed: [], revision: 8,
    })).toThrow();
    expect(() => parseTeamShutdownResult({
      closed: ['session-a'], failed: [{ sessionId: 'session-a', reason: 'failed' }], revision: 8,
    })).toThrow();
  });

  it('rejects a detail that would exceed one transport frame', () => {
    const oversizedMessages = Array.from({ length: 60 }, (_, index) => ({
      id: `message-${index}`,
      fromSessionId: 'session-a',
      toSessionId: 'session-a',
      body: 'x'.repeat(60 * 1024),
      status: 'delivered',
      statusReason: null,
      sentAt: index,
      replyToMessageId: null,
    }));
    expect(() => parseTeamGetResult({
      team: { ...detail(), recentMessages: oversizedMessages },
      revision: 7,
    })).toThrow();
  });
});
