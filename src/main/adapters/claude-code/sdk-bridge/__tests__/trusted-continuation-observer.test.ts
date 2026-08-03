import { describe, expect, it } from 'vitest';
import { TrustedContinuationAcceptanceController } from '@main/adapters/trusted-continuation';
import { makeInternalSession } from '../types';
import { observeClaudeTrustedContinuationFrame } from '../trusted-continuation-observer';

function harness() {
  const acceptance = new TrustedContinuationAcceptanceController();
  const internal = makeInternalSession({
    cwd: '/repo',
    applicationSid: 'claude-candidate',
    trustedContinuationAcceptance: acceptance,
  });
  return { acceptance, internal };
}

async function remainsPending(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(() => false),
    Promise.resolve().then(() => true),
  ]);
}

describe('Claude trusted continuation observer', () => {
  it('ignores lifecycle, configuration, and echoed user frames', async () => {
    const h = harness();
    observeClaudeTrustedContinuationFrame(h.internal, {
      type: 'system', subtype: 'init', model: 'claude-opus-4-8',
    });
    observeClaudeTrustedContinuationFrame(h.internal, { type: 'user', message: {} });
    expect(await remainsPending(h.acceptance.acceptance)).toBe(true);
  });

  it('accepts a native model stream boundary', async () => {
    const h = harness();
    observeClaudeTrustedContinuationFrame(h.internal, {
      type: 'stream_event', event: { type: 'message_start' },
    });
    await expect(h.acceptance.acceptance).resolves.toEqual({
      status: 'accepted', boundary: 'model-activity',
    });
  });

  it('classifies only structured prompt_too_long as a context rejection', async () => {
    const structured = harness();
    observeClaudeTrustedContinuationFrame(structured.internal, {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      terminal_reason: 'prompt_too_long',
    });
    await expect(structured.acceptance.acceptance).resolves.toEqual({
      status: 'rejected', reason: 'context-window-exceeded',
    });

    const freeText = harness();
    observeClaudeTrustedContinuationFrame(freeText.internal, {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['free text says prompt_too_long'],
    });
    await expect(freeText.acceptance.acceptance).resolves.toEqual({
      status: 'rejected', reason: 'provider-error',
    });
  });
});
