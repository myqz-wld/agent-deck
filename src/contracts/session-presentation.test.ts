import { describe, expect, it } from 'vitest';

import {
  parseSessionPresentationListParams,
  parseSessionPresentationListResult,
  type SessionPresentationSummaryDto,
} from './session-presentation';

function session(overrides: Partial<SessionPresentationSummaryDto> = {}): SessionPresentationSummaryDto {
  return {
    id: 'session-a', adapterId: 'codex-cli', title: 'Session A', source: 'sdk',
    lifecycle: 'active', activity: 'working', archived: false, pinned: true,
    createdAt: 1, updatedAt: 2, endedAt: null, model: 'gpt-5.6-sol', thinking: 'high',
    runtimeProvider: 'openai', context: { usedTokens: 12, windowTokens: 100 },
    spawnedBy: null, spawnDepth: 0,
    teams: [{ teamId: 'team-a', teamName: 'Team A', role: 'lead', joinedAt: 1 }],
    summary: 'Safe summary', summaryGenerationSource: 'llm', workspaceLabel: 'Project A',
    contextOnly: false,
    ...overrides,
  };
}

describe('session presentation contract', () => {
  it('permits archived-only filtering only for history pages', () => {
    expect(parseSessionPresentationListParams({
      kind: 'history', archivedOnly: true, limit: 40,
    })).toEqual({ kind: 'history', archivedOnly: true, limit: 40 });
    expect(() => parseSessionPresentationListParams({
      kind: 'live', archivedOnly: true, limit: 40,
    })).toThrow(/archivedOnly/);
  });

  it('parses an exact typed page and authoritative counts', () => {
    expect(parseSessionPresentationListResult({
      sessions: [session()],
      nextCursor: 'v1:live:4:1',
      counts: { total: 4, active: 3, dormant: 1, closed: 0, working: 1, waiting: 1 },
      contextTruncated: false,
      revision: 4,
    }, 1)).toMatchObject({ sessions: [{ lifecycle: 'active', pinned: true }], revision: 4 });
  });

  it('keeps summary provenance when a current service provides it', () => {
    const parsed = parseSessionPresentationListResult({
      sessions: [session({ summaryGenerationSource: 'assistant-fallback' })],
      nextCursor: null,
      counts: { total: 1, active: 1, dormant: 0, closed: 0, working: 1, waiting: 0 },
      contextTruncated: false,
      revision: 1,
    }, 1);
    expect(parsed.sessions[0]?.summaryGenerationSource).toBe('assistant-fallback');
  });

  it('rejects unknown lifecycle/activity values, duplicate teams and extra fields', () => {
    expect(() => parseSessionPresentationListResult({
      sessions: [{ ...session(), lifecycle: 'future' }],
      nextCursor: null,
      counts: { total: 1, active: 1, dormant: 0, closed: 0, working: 1, waiting: 0 },
      contextTruncated: false,
      revision: 1,
    }, 1)).toThrow(/lifecycle/);
    expect(() => parseSessionPresentationListResult({
      sessions: [{ ...session(), teams: [session().teams[0], session().teams[0]] }],
      nextCursor: null,
      counts: { total: 1, active: 1, dormant: 0, closed: 0, working: 1, waiting: 0 },
      contextTruncated: false,
      revision: 1,
    }, 1)).toThrow(/teams/);
    expect(() => parseSessionPresentationListParams({ kind: 'live', limit: 40, secret: 'x' }))
      .toThrow(/params/);
  });

  it('permits bounded context owners without consuming the primary page limit', () => {
    const result = parseSessionPresentationListResult({
      sessions: [session(), session({ id: 'parent-a', contextOnly: true })],
      nextCursor: null,
      counts: { total: 1, active: 1, dormant: 0, closed: 0, working: 1, waiting: 0 },
      contextTruncated: false,
      revision: 1,
    }, 1);
    expect(result.sessions).toHaveLength(2);
  });
});
