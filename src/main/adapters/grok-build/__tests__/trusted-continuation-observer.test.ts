import { describe, expect, it } from 'vitest';
import { TrustedContinuationAcceptanceController } from '@main/adapters/trusted-continuation';
import type { GrokRuntime } from '../runtime-types';
import { observeGrokTrustedContinuationFinished } from '../trusted-continuation-observer';

function harness() {
  const acceptance = new TrustedContinuationAcceptanceController();
  const runtime = { trustedContinuationAcceptance: acceptance } as GrokRuntime;
  return { acceptance, runtime };
}

describe('Grok trusted continuation terminal observer', () => {
  it('accepts a successful native terminal when no earlier update arrived', async () => {
    const h = harness();
    observeGrokTrustedContinuationFinished(h.runtime, { ok: true, subtype: 'end_turn' });
    await expect(h.acceptance.acceptance).resolves.toEqual({
      status: 'accepted', boundary: 'model-activity',
    });
  });

  it('requires the adapter-normalized structured failure reason', async () => {
    const structured = harness();
    observeGrokTrustedContinuationFinished(structured.runtime, {
      ok: false,
      subtype: 'error',
      failureReason: 'context-window-exceeded',
    });
    await expect(structured.acceptance.acceptance).resolves.toEqual({
      status: 'rejected', reason: 'context-window-exceeded',
    });

    const freeText = harness();
    observeGrokTrustedContinuationFinished(freeText.runtime, {
      ok: false,
      subtype: 'context-window-exceeded appears only as text',
    });
    await expect(freeText.acceptance.acceptance).resolves.toEqual({
      status: 'rejected', reason: 'provider-error',
    });
  });
});
