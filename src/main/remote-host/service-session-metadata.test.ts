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

function permissions(adapterId: 'codex-cli' | 'grok-build' = 'codex-cli') {
  return adapterId === 'codex-cli'
    ? {
        sessionId: 'session-a', adapterId,
        effective: {
          adapterId, approvalPolicy: 'on-request', approvalPolicySource: 'session',
          sandbox: 'workspace-write', sandboxSource: 'session',
        },
        workspace: { read: 'allowed', write: 'allowed', network: 'provider-default' },
        rules: { state: 'unavailable', items: [], omittedCount: 0, truncated: false },
        revision: 7,
      }
    : {
        sessionId: 'session-a', adapterId,
        effective: {
          adapterId, sessionMode: 'default', sessionModeSource: 'provider-default',
          sandbox: 'provider-default', sandboxSource: 'provider-default',
        },
        workspace: {
          read: 'provider-default', write: 'provider-default', network: 'provider-default',
        },
        rules: { state: 'unavailable', items: [], omittedCount: 0, truncated: false },
        revision: 7,
      };
}

describe('RemoteHostSessionMetadataController', () => {
  it('binds the path-free Permissions result to the requested session and adapter', async () => {
    const clientRequest = vi.fn(async () => permissions());
    const scope = scoped(clientRequest);
    const controller = new RemoteHostSessionMetadataController(scope.request, vi.fn());

    await expect(controller.permissions({
      profileId: 'remote-a', sessionId: 'session-a', adapterId: 'codex-cli',
    })).resolves.toMatchObject({
      sessionId: 'session-a', adapterId: 'codex-cli', revision: 7,
    });
    expect(scope.admitted).toHaveBeenCalledWith(
      'remote-a', 'session.permissions.get', expect.any(Function),
    );
    expect(clientRequest).toHaveBeenCalledWith(
      'session.permissions.get', { sessionId: 'session-a' }, { deadlineMs: 45_000 },
    );

    clientRequest.mockResolvedValueOnce(permissions('grok-build'));
    await expect(controller.permissions({
      profileId: 'remote-a', sessionId: 'session-a', adapterId: 'codex-cli',
    })).rejects.toThrow(/identity changed/u);
  });

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
