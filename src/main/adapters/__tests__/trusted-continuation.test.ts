import { describe, expect, it } from 'vitest';

import { TrustedContinuationAcceptanceController } from '../trusted-continuation';

describe('TrustedContinuationAcceptanceController', () => {
  it('keeps first model activity authoritative over a later terminal failure', async () => {
    const controller = new TrustedContinuationAcceptanceController();

    controller.acceptModelActivity();
    controller.reject('context-window-exceeded');

    await expect(controller.acceptance).resolves.toEqual({
      status: 'accepted', boundary: 'model-activity',
    });
  });

  it('keeps a pre-activity rejection authoritative over later activity', async () => {
    const controller = new TrustedContinuationAcceptanceController();

    controller.reject('provider-error');
    controller.acceptModelActivity();

    await expect(controller.acceptance).resolves.toEqual({
      status: 'rejected', reason: 'provider-error',
    });
  });
});
