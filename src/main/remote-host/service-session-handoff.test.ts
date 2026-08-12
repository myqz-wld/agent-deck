import { describe, expect, it, vi } from 'vitest';

import { sessionConsoleCreateOptionsFixture } from '@contracts/session-console-capabilities.fixture';
import type { RemoteHostScopedClient } from './service-scope';
import { RemoteHostSessionHandOffController } from './service-session-handoff';

const EXPECTED_AUTHORITY = {
  authoritativeCoreId: 'core-a',
  workerGeneration: 3,
};

function scoped(clientRequest: ReturnType<typeof vi.fn>, scopeCurrent = true) {
  const scope: RemoteHostScopedClient = {
    client: { request: clientRequest } as unknown as RemoteHostScopedClient['client'],
    profileEpoch: 1,
    profileId: 'remote-a',
    sourceEpoch: 1,
  };
  const admitted = vi.fn(async (
    _profileId: string,
    _method: string,
    run: (scope: RemoteHostScopedClient) => Promise<unknown>,
  ) => run(scope));
  const terminal = vi.fn(async (
    _profileId: string,
    _method: string,
    run: (scope: RemoteHostScopedClient) => Promise<unknown>,
    onCurrent?: (result: unknown) => void,
  ) => {
    const result = await run(scope);
    if (scopeCurrent) onCurrent?.(result);
    return { result, scopeCurrent };
  });
  return { admitted, request: admitted as never, terminal: terminal as never };
}

const target = {
  adapterId: 'codex-cli' as const,
  workingDirectory: null,
  capabilityRevision: null,
  options: sessionConsoleCreateOptionsFixture(),
};

function previewResult() {
  return {
    bindingDigest: `sha256:${'b'.repeat(64)}`,
    preview: 'bounded continuation',
    previewTruncated: false,
    quality: 'full',
    source: { eventRevision: 4, rebuildAfterRevision: 0 },
    checkpoint: { id: 1, throughRevision: 4, formatVersion: 2, refreshed: false },
    metrics: {
      estimatedPromptTokens: 100,
      checkpointTokens: 40,
      rawTailTokens: 60,
      includedUserMessages: 3,
      truncatedBoundaryMessages: 0,
      rawRetentionCeilingTokens: 1_000,
      elapsedMs: 5,
    },
    warnings: [],
    target: {
      ...target,
      workingDirectory: 'repo',
      capabilityRevision: `sha256:${'a'.repeat(64)}`,
    },
    revision: 8,
  };
}

describe('RemoteHostSessionHandOffController', () => {
  it('previews through the selected Core with a bounded handoff deadline', async () => {
    const clientRequest = vi.fn(async () => previewResult());
    const scope = scoped(clientRequest);
    const controller = new RemoteHostSessionHandOffController(
      scope.request,
      scope.terminal,
      vi.fn(),
      vi.fn(),
    );
    const request = {
      profileId: 'remote-a',
      sessionId: 'session-a',
      continuationInstruction: 'Continue.',
      target,
    };

    await expect(controller.preview(request)).resolves.toMatchObject({
      bindingDigest: `sha256:${'b'.repeat(64)}`,
    });
    expect(clientRequest).toHaveBeenCalledWith(
      'session.handoff.preview',
      { sessionId: 'session-a', continuationInstruction: 'Continue.', target },
      { deadlineMs: 315_000 },
    );
  });

  it('binds commit idempotency and selects only the Core-returned successor', async () => {
    const clientRequest = vi.fn(async () => ({
      successorSessionId: 'session-successor',
      cutoverEventRevision: 5,
      lateMessagesDelivered: 1,
      usedLowerBudgetRetry: false,
      sourceFinalizationWarning: null,
      revision: 9,
    }));
    const scope = scoped(clientRequest);
    const selectSuccessor = vi.fn();
    const controller = new RemoteHostSessionHandOffController(
      scope.request,
      scope.terminal,
      (operation, profileId, intentId) => `${operation}:${profileId}:${intentId}`,
      selectSuccessor,
    );
    await controller.commit({
      profileId: 'remote-a',
      sessionId: 'session-a',
      continuationInstruction: 'Continue.',
      target,
      expectedAuthority: EXPECTED_AUTHORITY,
      expectedBindingDigest: `sha256:${'b'.repeat(64)}`,
      intentId: 'intent-a',
    });

    expect(clientRequest).toHaveBeenCalledWith(
      'session.handoff.commit',
      expect.objectContaining({ expectedBindingDigest: `sha256:${'b'.repeat(64)}` }),
      { deadlineMs: 315_000, idempotencyKey: 'handoff:remote-a:intent-a' },
    );
    expect(selectSuccessor).toHaveBeenCalledWith('remote-a', 'session-successor');
  });

  it('returns a terminal Core result without selecting into a replacement scope', async () => {
    const clientRequest = vi.fn(async () => ({
      successorSessionId: 'session-successor', cutoverEventRevision: 5,
      lateMessagesDelivered: 0, usedLowerBudgetRetry: false,
      sourceFinalizationWarning: null, revision: 9,
    }));
    const scope = scoped(clientRequest, false);
    const selectSuccessor = vi.fn();
    const controller = new RemoteHostSessionHandOffController(
      scope.request,
      scope.terminal,
      () => 'handoff:remote-a:intent-a',
      selectSuccessor,
    );

    await expect(controller.commit({
      profileId: 'remote-a', sessionId: 'session-a', continuationInstruction: 'Continue.',
      target, expectedAuthority: EXPECTED_AUTHORITY,
      expectedBindingDigest: `sha256:${'b'.repeat(64)}`, intentId: 'intent-a',
    })).resolves.toMatchObject({ successorSessionId: 'session-successor' });
    expect(selectSuccessor).not.toHaveBeenCalled();
  });
});
