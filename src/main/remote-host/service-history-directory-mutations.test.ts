import { describe, expect, it, vi } from 'vitest';

import type { AgentDeckClient } from '@contracts/index';
import type { RemoteHostScopedRequest } from './service-scope';

import {
  RemoteHostSessionHistoryMutationController,
  RemoteHostWorkspaceDirectoryMutationController,
} from './service-history-directory-mutations';

const expectedAuthority = { authoritativeCoreId: 'core-a', workerGeneration: 3 };

function harness(result: unknown) {
  const client = { request: vi.fn(async () => result) } as unknown as AgentDeckClient;
  const request = vi.fn(async (
    profileId: string,
    _method: string,
    run: (scope: { client: AgentDeckClient; profileId: string }) => Promise<unknown>,
  ) => run({ client, profileId })) as unknown as RemoteHostScopedRequest;
  const mutationId = vi.fn((operation: string, profileId: string, intentId: string) =>
    `${operation}:${profileId}:${intentId}`);
  return { client, mutationId, request };
}

describe('Remote history and Workspace mutation controllers', () => {
  it('binds history row CAS, idempotency and expected Core authority', async () => {
    const state = harness({ sessionId: 'session-a', state: 'archived', revision: 8 });
    const controller = new RemoteHostSessionHistoryMutationController(
      state.request,
      state.mutationId,
    );
    await expect(controller.archive({
      profileId: 'remote-a', sessionId: 'session-a', expectedArchived: false,
      expectedUpdatedAt: 7, expectedAuthority, intentId: 'intent-a',
    })).resolves.toEqual({ sessionId: 'session-a', state: 'archived', revision: 8 });
    expect(state.request).toHaveBeenCalledWith(
      'remote-a', 'session.archive', expect.any(Function), [], expectedAuthority,
    );
    expect(state.client.request).toHaveBeenCalledWith(
      'session.archive',
      { sessionId: 'session-a', expectedArchived: false, expectedUpdatedAt: 7 },
      expect.objectContaining({ idempotencyKey: 'archive:remote-a:intent-a' }),
    );
  });

  it('routes dormant reactivation through its separately negotiated method', async () => {
    const state = harness({ sessionId: 'session-a', state: 'reactivated', revision: 9 });
    const controller = new RemoteHostSessionHistoryMutationController(
      state.request,
      state.mutationId,
    );
    await expect(controller.reactivate({
      profileId: 'remote-a', sessionId: 'session-a', expectedArchived: false,
      expectedUpdatedAt: 8, expectedAuthority, intentId: 'intent-r',
    })).resolves.toEqual({ sessionId: 'session-a', state: 'reactivated', revision: 9 });
    expect(state.client.request).toHaveBeenCalledWith(
      'session.reactivate',
      { sessionId: 'session-a', expectedArchived: false, expectedUpdatedAt: 8 },
      expect.objectContaining({ idempotencyKey: 'reactivate:remote-a:intent-r' }),
    );
  });

  it('returns only the Workspace-relative directory from Core', async () => {
    const state = harness({ directory: 'repo/new-folder', revision: 8 });
    const controller = new RemoteHostWorkspaceDirectoryMutationController(
      state.request,
      state.mutationId,
    );
    await expect(controller.create({
      profileId: 'remote-a', parentDirectory: 'repo', name: 'new-folder',
      expectedAuthority, intentId: 'intent-directory-a',
    })).resolves.toEqual({ directory: 'repo/new-folder', revision: 8 });
    expect(state.request).toHaveBeenCalledWith(
      'remote-a', 'workspace.directory.create', expect.any(Function), [], expectedAuthority,
    );
    expect(state.client.request).toHaveBeenCalledWith(
      'workspace.directory.create',
      { parentDirectory: 'repo', name: 'new-folder' },
      expect.objectContaining({
        idempotencyKey: 'workspace-directory-create:remote-a:intent-directory-a',
      }),
    );
  });
});
