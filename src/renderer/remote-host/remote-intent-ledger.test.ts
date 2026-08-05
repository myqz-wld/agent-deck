import { describe, expect, it, vi } from 'vitest';

import { RemoteUserIntentLedger } from './remote-intent-ledger';

describe('RemoteUserIntentLedger', () => {
  it.each(['create', 'send'])('reuses one %s intent after an ambiguous failure and rotates after success', async (operation) => {
    let sequence = 0;
    const ledger = new RemoteUserIntentLedger(() => `intent-${++sequence}`);
    const request = vi.fn(async (intentId: string) => {
      if (request.mock.calls.length === 1) throw new Error('deadline exceeded');
      return intentId;
    });
    const payload = operation === 'create'
      ? { adapterId: 'codex-cli', projectRef: 'opaque-project' }
      : { sessionId: 'session-a', text: 'hello' };

    await expect(ledger.run('remote-a:core-a:1', operation, payload, request))
      .rejects.toThrow('deadline exceeded');
    await expect(ledger.run('remote-a:core-a:1', operation, payload, request))
      .resolves.toBe('intent-1');
    await expect(ledger.run('remote-a:core-a:1', operation, payload, request))
      .resolves.toBe('intent-2');

    expect(request.mock.calls.map(([intentId]) => intentId)).toEqual([
      'intent-1',
      'intent-1',
      'intent-2',
    ]);
  });

  it('source-qualifies otherwise identical user intents', () => {
    let sequence = 0;
    const ledger = new RemoteUserIntentLedger(() => `intent-${++sequence}`);
    const first = ledger.acquire('remote-a:core-a:1', 'send', { text: 'same' });
    const second = ledger.acquire('remote-b:core-b:1', 'send', { text: 'same' });
    expect(first.id).not.toBe(second.id);
  });
});
