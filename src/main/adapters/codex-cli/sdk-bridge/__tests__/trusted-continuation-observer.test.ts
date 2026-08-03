import { describe, expect, it } from 'vitest';
import { TrustedContinuationAcceptanceController } from '@main/adapters/trusted-continuation';
import type { CodexAppServerNotification } from '../../app-server/client';
import type { InternalSession } from '../types';
import { observeCodexTrustedContinuationNotification } from '../trusted-continuation-observer';

function harness() {
  const acceptance = new TrustedContinuationAcceptanceController();
  return {
    acceptance,
    internal: { trustedContinuationAcceptance: acceptance } as InternalSession,
  };
}

function notification(method: string, params: unknown = {}): CodexAppServerNotification {
  return { method, params } as CodexAppServerNotification;
}

async function remainsPending(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(() => false),
    Promise.resolve().then(() => true),
  ]);
}

describe('Codex trusted continuation observer', () => {
  it('ignores lifecycle and echoed user input but accepts model activity', async () => {
    const h = harness();
    observeCodexTrustedContinuationNotification(h.internal, notification('turn/started'));
    observeCodexTrustedContinuationNotification(
      h.internal,
      notification('item/started', { item: { type: 'userMessage' } }),
    );
    expect(await remainsPending(h.acceptance.acceptance)).toBe(true);

    observeCodexTrustedContinuationNotification(
      h.internal,
      notification('item/agentMessage/delta'),
    );
    await expect(h.acceptance.acceptance).resolves.toEqual({
      status: 'accepted', boundary: 'model-activity',
    });
  });

  it('requires exact codexErrorInfo for a context rejection', async () => {
    const structured = harness();
    observeCodexTrustedContinuationNotification(
      structured.internal,
      notification('error', {
        willRetry: false,
        error: { message: 'too large', codexErrorInfo: 'contextWindowExceeded' },
      }),
    );
    await expect(structured.acceptance.acceptance).resolves.toEqual({
      status: 'rejected', reason: 'context-window-exceeded',
    });

    const freeText = harness();
    observeCodexTrustedContinuationNotification(
      freeText.internal,
      notification('error', {
        willRetry: false,
        error: { message: 'text says contextWindowExceeded' },
      }),
    );
    await expect(freeText.acceptance.acceptance).resolves.toEqual({
      status: 'rejected', reason: 'provider-error',
    });
  });

  it('ignores pre-model accounting, hooks, compaction, and unknown item types', async () => {
    const h = harness();
    for (const candidate of [
      notification('thread/tokenUsage/updated', { tokenUsage: { last: {} } }),
      notification('item/started', { item: { type: 'hookPrompt' } }),
      notification('item/started', { item: { type: 'contextCompaction' } }),
      notification('item/started', { item: { type: 'futureLifecycleItem' } }),
    ]) {
      observeCodexTrustedContinuationNotification(h.internal, candidate);
    }
    expect(await remainsPending(h.acceptance.acceptance)).toBe(true);

    observeCodexTrustedContinuationNotification(
      h.internal,
      notification('error', {
        willRetry: false,
        error: { message: 'too large', codexErrorInfo: 'contextWindowExceeded' },
      }),
    );
    await expect(h.acceptance.acceptance).resolves.toEqual({
      status: 'rejected', reason: 'context-window-exceeded',
    });
  });

  it('classifies a failed terminal before treating completion as acceptance', async () => {
    const h = harness();
    observeCodexTrustedContinuationNotification(
      h.internal,
      notification('turn/completed', {
        turn: {
          status: 'failed',
          error: { message: 'too large', codexErrorInfo: 'contextWindowExceeded' },
        },
      }),
    );
    await expect(h.acceptance.acceptance).resolves.toEqual({
      status: 'rejected', reason: 'context-window-exceeded',
    });
  });
});
