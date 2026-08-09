import { describe, expect, it, vi } from 'vitest';

import {
  RemoteUserIntentLedger,
  remoteSessionCreateIntentPayload,
} from './remote-intent-ledger';

describe('RemoteUserIntentLedger', () => {
  it.each(['create', 'send'])('reuses one %s intent after an ambiguous failure and rotates after success', async (operation) => {
    let sequence = 0;
    const ledger = new RemoteUserIntentLedger(() => `intent-${++sequence}`);
    const request = vi.fn(async (intentId: string) => {
      if (request.mock.calls.length === 1) throw new Error('deadline exceeded');
      return intentId;
    });
    const payload = operation === 'create'
      ? { adapterId: 'codex-cli', initialMessage: 'Inspect the repository', workingDirectory: 'repo/subdir' }
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

  it('retains ambiguous intents across navigation and retires superseded identities', async () => {
    let sequence = 0;
    const ledger = new RemoteUserIntentLedger(() => `intent-${++sequence}`);
    await expect(ledger.run('remote-a:core-a:1', 'send', { text: 'a' }, async () => {
      throw new Error('deadline exceeded');
    })).rejects.toThrow('deadline exceeded');

    ledger.retainSources(new Set(['remote-a:core-a:1', 'remote-b:core-b:1']));

    expect(ledger.acquire('remote-b:core-b:1', 'send', { text: 'b' }).id).toBe('intent-2');
    expect(ledger.acquire('remote-a:core-a:1', 'send', { text: 'a' }).id).toBe('intent-1');

    ledger.retainSources(new Set(['remote-b:core-b:1']));
    expect(ledger.acquire('remote-a:core-a:1', 'send', { text: 'a' }).id).toBe('intent-3');
  });

  it('bounds ambiguous intents per source without blocking another source', () => {
    let sequence = 0;
    const ledger = new RemoteUserIntentLedger(() => `intent-${++sequence}`);
    for (let index = 0; index < 64; index += 1) {
      ledger.acquire('remote-a:core-a:1', 'send', { text: `a-${index}` });
    }
    expect(() => ledger.acquire('remote-a:core-a:1', 'send', { text: 'overflow' }))
      .toThrow('待确认的远程操作过多');
    expect(ledger.acquire('remote-b:core-b:1', 'send', { text: 'still available' }).id)
      .toBe('intent-65');
  });

  it('content-binds large attachments without placing base64 bodies in the intent key', async () => {
    const create = (base64: string) => ({
      adapterId: 'codex-cli',
      attachments: [{ kind: 'image' as const, base64, mime: 'image/png' as const, bytes: 150_000 }],
      capabilityRevision: `sha256:${'a'.repeat(64)}`,
      initialMessage: '',
      options: {
        approvalPolicy: 'on-request', claudeCodeSandbox: null,
        codexSandbox: 'workspace-write', grokSandbox: null, model: '', permissionMode: null,
        provider: '', sessionMode: null, thinking: 'medium',
      },
      workingDirectory: '.',
    });
    const first = await remoteSessionCreateIntentPayload(create('a'.repeat(200_000)));
    const second = await remoteSessionCreateIntentPayload(create('b'.repeat(200_000)));
    expect(JSON.stringify(first)).not.toContain('a'.repeat(1_000));
    const ledger = new RemoteUserIntentLedger(() => 'intent-large');
    expect(ledger.acquire('remote-a:core-a:1', 'create', first).key)
      .not.toBe(ledger.acquire('remote-a:core-a:1', 'create', second).key);
  });
});
