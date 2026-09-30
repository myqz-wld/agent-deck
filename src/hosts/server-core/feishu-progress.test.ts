import { describe, expect, it, vi } from 'vitest';
import { issueRemoteOwnerAccessContext } from '@contracts/index';
import { runtimeCoreHarness, runtimeCoreInput } from './runtime-core.test-fixture';
import { createServerCoreSessionManagerObserver } from './session-manager-observer';
import type { ServerCoreRuntimeMetadataStore } from './runtime-metadata-store';
import type { TokenUsageRepo } from '@main/store/token-usage-repo';
import { ServerCoreProviderEventBus } from './provider-event-bus';

describe('Feishu provider execution progress', () => {
  it('correlates Feishu send to actual adapter acceptance without changing desktop enqueue semantics', async () => {
    const f = runtimeCoreHarness(); await f.runtime.start();
    const params = { sessionId: 'session-a', text: 'read-only check' };
    await f.runtime.execute(runtimeCoreInput('session.send', params, { idempotencyKey: 'desktop-event' }));
    const request = { ...runtimeCoreInput('session.send', params, { idempotencyKey: 'feishu:message-1' }),
      access: issueRemoteOwnerAccessContext({ topology: 'full', instanceId: 'instance-a',
        clientId: 'feishu-client', connectionScope: 'credential-feishu', surface: 'feishu' }) };
    await f.runtime.execute(request);
    expect(f.sendMessage.mock.calls).toEqual([
      ['session-a', 'read-only check', undefined, { idempotencyKey: 'desktop-event' }],
      ['session-a', 'read-only check', undefined, { idempotencyKey: 'feishu:message-1',
        deferUserEventUntilTurnStart: true, turnCorrelationId: 'feishu:message-1' }],
    ]);
    await f.runtime.execute(request);
    expect(f.sendMessage).toHaveBeenCalledTimes(2);
    await f.runtime.stop('shutdown');
  });

  it('publishes only bounded turn identity and completion flags, without text or native error payloads', () => {
    const appendChange = vi.fn();
    const observer = createServerCoreSessionManagerObserver({
      metadata: { appendChange } as unknown as ServerCoreRuntimeMetadataStore,
      diagnostics: { info() {}, warn() {} }, reviewEvents: new ServerCoreProviderEventBus(),
      tokenUsage: {} as TokenUsageRepo,
    });
    observer.eventPersisted({ sessionId: 'session-a', agentId: 'codex-cli', kind: 'message', ts: 1,
      payload: { role: 'user', text: 'private body', turnCorrelationId: 'feishu:message-1' } }, 10);
    observer.eventPersisted({ sessionId: 'session-a', agentId: 'codex-cli', kind: 'finished', ts: 2,
      payload: { ok: false, error: 'private error', apiKey: 'private credential' } }, 11);
    expect(appendChange.mock.calls).toEqual([
      ['event.persisted', 'session-a', { adapterId: 'codex-cli', eventId: 10, kind: 'message', timestamp: 1,
        role: 'user', correlationId: 'feishu:message-1' }],
      ['event.persisted', 'session-a', { adapterId: 'codex-cli', eventId: 11, kind: 'finished', timestamp: 2, ok: false }],
    ]);
    expect(JSON.stringify(appendChange.mock.calls)).not.toContain('private');
  });
});
