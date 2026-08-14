import { describe, expect, it, vi } from 'vitest';

import type { RemoteHostScopedClient } from './service-scope';
import { RemoteHostSessionMetadataController } from './service-session-metadata';

const EXPECTED_AUTHORITY = {
  authoritativeCoreId: 'core-a',
  workerGeneration: 3,
};

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

describe('RemoteHostSessionMetadataController', () => {
  it('re-parses message membership and rejects a row for an unrelated session', async () => {
    const clientRequest = vi.fn(async () => ({
      sessionId: 'session-a',
      messages: [{
        id: 'message-a', teamId: null,
        fromSessionId: 'other-a', fromTitle: 'Other A',
        toSessionId: 'other-b', toTitle: 'Other B',
        body: 'not for session-a', status: 'delivered', statusReason: null,
        sentAt: 1, deliveredAt: 2, replyToMessageId: null,
      }],
      truncated: false,
      revision: 4,
    }));
    const scope = scoped(clientRequest);
    const controller = new RemoteHostSessionMetadataController(scope.request, vi.fn());

    await expect(controller.messages({
      profileId: 'remote-a', sessionId: 'session-a', limit: 100,
    })).rejects.toThrow(/messages/u);
  });

  it('uses a stable mutation id for path-free outgoing removal', async () => {
    const clientRequest = vi.fn(async () => ({ removed: true, revision: 9 }));
    const scope = scoped(clientRequest);
    const controller = new RemoteHostSessionMetadataController(
      scope.request,
      (operation, profileId, intentId) => `${operation}:${profileId}:${intentId}`,
    );

    await expect(controller.removeOutgoing({
      profileId: 'remote-a', sessionId: 'session-a', messageId: 'message-a',
      expectedAuthority: EXPECTED_AUTHORITY, intentId: 'intent-a',
    })).resolves.toEqual({ removed: true, revision: 9 });
    expect(clientRequest).toHaveBeenCalledWith(
      'session.outgoing.remove',
      { sessionId: 'session-a', messageId: 'message-a' },
      { deadlineMs: 45_000, idempotencyKey: 'outgoing-remove:remote-a:intent-a' },
    );
  });
});
