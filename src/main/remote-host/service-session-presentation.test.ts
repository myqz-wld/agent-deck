import { describe, expect, it, vi } from 'vitest';

import type { RemoteHostScopedClient } from './service-scope';
import { RemoteHostSessionPresentationController } from './service-session-presentation';

function scoped(clientRequest: ReturnType<typeof vi.fn>) {
  const admitted = vi.fn(async (
    _profileId: string,
    _method: string,
    run: (scope: RemoteHostScopedClient) => Promise<unknown>,
  ) => run({
    client: { request: clientRequest } as unknown as RemoteHostScopedClient['client'],
    profileEpoch: 1,
    profileId: 'remote-a',
    sourceEpoch: 1,
  }));
  return { admitted, request: admitted as never };
}

const session = {
  id: 'session-a', adapterId: 'codex-cli', title: 'Session A', source: 'sdk',
  lifecycle: 'active', activity: 'waiting', archived: false, pinned: false,
  createdAt: 1, updatedAt: 2, endedAt: null, model: null, thinking: null,
  runtimeProvider: null, context: null, spawnedBy: null, spawnDepth: 0, teams: [],
  summary: null, summaryGenerationSource: null, workspaceLabel: 'Workspace', contextOnly: false,
} as const;

const permissionDisplay = {
  schema: 'agent-deck.permission-preview.v1',
  tool: 'Bash',
  input: { command: 'pwd' },
  complete: true,
  redacted: false,
} as const;

describe('RemoteHostSessionPresentationController', () => {
  it('binds typed list reads to the admitted profile and exact deadline', async () => {
    const clientRequest = vi.fn(async () => ({
      sessions: [session], nextCursor: null,
      counts: { total: 1, active: 1, dormant: 0, closed: 0, working: 0, waiting: 1 },
      contextTruncated: false, revision: 7,
    }));
    const scope = scoped(clientRequest);
    const controller = new RemoteHostSessionPresentationController(scope.request);
    await expect(controller.list({ profileId: 'remote-a', kind: 'live', limit: 40 }))
      .resolves.toMatchObject({ sessions: [{ id: 'session-a' }], revision: 7 });
    expect(scope.admitted).toHaveBeenCalledWith(
      'remote-a', 'session.presentation.list', expect.any(Function),
    );
    expect(clientRequest).toHaveBeenCalledWith(
      'session.presentation.list', { kind: 'live', limit: 40 }, { deadlineMs: 45_000 },
    );
  });

  it('re-parses aggregate Pending semantics and rejects cross-session rows', async () => {
    const clientRequest = vi.fn(async () => ({
      buckets: [{
        session,
        requests: [{
          id: 'request-a', sessionId: 'session-a', kind: 'permission', status: 'pending',
          createdAt: 2, expiresAt: null, display: permissionDisplay,
        }],
        revision: 8,
      }],
      nextCursor: null, totalBuckets: 1, totalRequests: 1,
      scanTruncated: false, revision: 8,
    }));
    const scope = scoped(clientRequest);
    const controller = new RemoteHostSessionPresentationController(scope.request);
    await expect(controller.pending({ profileId: 'remote-a', limit: 25 }))
      .resolves.toMatchObject({ buckets: [{ pending: { revision: 8 } }] });
    clientRequest.mockResolvedValueOnce({
      buckets: [{
        session,
        requests: [{
          id: 'request-b', sessionId: 'other', kind: 'permission', status: 'pending',
          createdAt: 2, expiresAt: null, display: permissionDisplay,
        }],
        revision: 8,
      }],
      nextCursor: null, totalBuckets: 1, totalRequests: 1,
      scanTruncated: false, revision: 8,
    });
    await expect(controller.pending({ profileId: 'remote-a', limit: 25 })).rejects.toThrow();
  });
});
