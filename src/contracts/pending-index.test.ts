import { describe, expect, it } from 'vitest';

import { parsePendingIndexListResult } from './pending-index';
import type { SessionPresentationSummaryDto } from './session-presentation';

const session: SessionPresentationSummaryDto = {
  id: 'session-a', adapterId: 'claude-code', title: 'Session A', source: 'sdk',
  lifecycle: 'active', activity: 'waiting', archived: false, pinned: false,
  createdAt: 1, updatedAt: 2, endedAt: null, model: null, thinking: null,
  runtimeProvider: null, context: null, spawnedBy: null, spawnDepth: 0, teams: [],
  summary: null, summaryGenerationSource: null, workspaceLabel: 'Workspace', contextOnly: false,
};

describe('pending index contract', () => {
  it('binds every bounded request to its projected session', () => {
    const result = parsePendingIndexListResult({
      buckets: [{
        session,
        requests: [{
          id: 'request-a', sessionId: session.id, kind: 'permission', status: 'pending',
          createdAt: 2, expiresAt: null, display: { schema: 'permission-preview.v1' },
        }],
        revision: 7,
      }],
      nextCursor: null,
      totalBuckets: 1,
      totalRequests: 1,
      scanTruncated: false,
      revision: 7,
    }, 1);
    expect(result.buckets[0]?.requests[0]?.sessionId).toBe(session.id);
  });

  it('rejects mismatched identities, context-only sessions and dishonest totals', () => {
    const base = {
      buckets: [{
        session,
        requests: [{
          id: 'request-a', sessionId: 'other', kind: 'permission', status: 'pending',
          createdAt: 2, expiresAt: null, display: {},
        }],
        revision: 7,
      }],
      nextCursor: null,
      totalBuckets: 1,
      totalRequests: 1,
      scanTruncated: false,
      revision: 7,
    };
    expect(() => parsePendingIndexListResult(base, 1)).toThrow(/sessionId/);
    expect(() => parsePendingIndexListResult({
      ...base,
      buckets: [{ ...base.buckets[0], session: { ...session, contextOnly: true }, requests: [] }],
      totalRequests: 0,
    }, 1)).toThrow(/buckets/);
    expect(() => parsePendingIndexListResult({
      ...base,
      buckets: [],
      totalBuckets: 0,
      totalRequests: 0,
      extra: true,
    }, 1)).toThrow(/result/);
  });
});
