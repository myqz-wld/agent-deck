import { describe, expect, it } from 'vitest';
import {
  InMemoryFeishuGatewayStore,
  type DeliveryClaim,
  type FeishuCursorRecord,
  type FeishuDeliveryRecord,
} from '.';
import {
  actionEvent,
  actionFrom,
  credential,
  flush,
  messageEvent,
  onlyClient,
  pending,
  select,
  setup,
} from './__tests__/fixture';

describe('untrusted metadata and resource ceilings', () => {
  it('fails active-credential and startup-chat cardinality before partial attachment', async () => {
    const credentials = new InMemoryFeishuGatewayStore();
    credentials.enroll(credential);
    credentials.enroll({
      ...credential,
      openId: 'open-2',
      credentialId: 'credential-2',
    });
    expect(() => setup({
      store: credentials,
      limits: { maxActiveCredentials: 1 },
    })).toThrowError(expect.objectContaining({ code: 'invalid_configuration' }));

    const contexts = new InMemoryFeishuGatewayStore();
    contexts.enroll(credential);
    for (const chatId of ['chat-a', 'chat-b']) {
      contexts.putContext({
        instanceId: credential.instanceId,
        credentialId: credential.credentialId,
        chatId,
        chatType: 'p2p',
        openId: credential.openId,
        activeSessionId: null,
        updatedAt: 1,
      });
    }
    const restarted = setup({
      store: contexts,
      limits: { maxConcurrentChatClients: 1 },
    });
    await expect(restarted.gateway.start()).rejects.toMatchObject({
      code: 'invalid_configuration',
    });
    expect(restarted.clients.size).toBe(0);
  });

  it('rejects a persisted context whose open-id is not bound to its credential', () => {
    const store = new InMemoryFeishuGatewayStore();
    store.enroll(credential);
    store.putContext({
      instanceId: credential.instanceId,
      credentialId: credential.credentialId,
      chatId: 'mismatched-context',
      chatType: 'p2p',
      openId: 'different-open-id',
      activeSessionId: null,
      updatedAt: 1,
    });
    expect(() => setup({ store })).toThrowError(expect.objectContaining({
      code: 'invalid_configuration',
    }));
  });

  it('bounds new contexts and creates none for duplicate or exhausted events', async () => {
    const store = new InMemoryFeishuGatewayStore();
    store.enroll(credential);
    store.putContext({
      instanceId: credential.instanceId,
      credentialId: credential.credentialId,
      chatId: 'existing-chat',
      chatType: 'p2p',
      openId: credential.openId,
      activeSessionId: null,
      updatedAt: 1,
    });
    const { gateway } = setup({
      store,
      limits: { maxPersistedContexts: 1, maxEventAttempts: 1 },
    });
    await expect(gateway.handle(messageEvent('context-limit', '/sessions', {
      chatId: 'new-chat',
    }))).rejects.toMatchObject({ code: 'invalid_configuration' });
    expect(store.getContext(credential.instanceId, credential.credentialId, 'new-chat')).toBeNull();

    const duplicateClaim = store.claimDelivery({
      instanceId: credential.instanceId,
      eventId: 'duplicate-no-context',
      credentialId: credential.credentialId,
      chatId: 'duplicate-chat',
      updatedAt: 2,
    }, 1);
    store.finishDelivery(
      credential.instanceId,
      'duplicate-no-context',
      duplicateClaim.record.attempts,
      'sent',
      3,
    );
    await expect(gateway.handle(messageEvent('duplicate-no-context', '/sessions', {
      chatId: 'duplicate-chat',
    }))).resolves.toMatchObject({ code: 'deduplicated' });
    expect(store.getContext(
      credential.instanceId,
      credential.credentialId,
      'duplicate-chat',
    )).toBeNull();

    const exhausted = store.claimDelivery({
      instanceId: credential.instanceId,
      eventId: 'exhausted-no-context',
      credentialId: credential.credentialId,
      chatId: 'exhausted-chat',
      updatedAt: 4,
    }, 1);
    store.finishDelivery(
      credential.instanceId,
      'exhausted-no-context',
      exhausted.record.attempts,
      'failed',
      5,
    );
    await expect(gateway.handle(messageEvent('exhausted-no-context', '/sessions', {
      chatId: 'exhausted-chat',
    }))).resolves.toMatchObject({ code: 'delivery_exhausted' });
    expect(store.getContext(
      credential.instanceId,
      credential.credentialId,
      'exhausted-chat',
    )).toBeNull();
  });

  it('bounds concurrent new-chat client and lane admission', async () => {
    const { gateway, clients } = setup({
      limits: { maxConcurrentChatClients: 1, maxNotificationLanes: 1 },
    });
    await expect(gateway.handle(messageEvent('chat-cap-a', '/sessions', {
      chatId: 'chat-a',
    }))).resolves.toMatchObject({ code: 'accepted' });
    await expect(gateway.handle(messageEvent('chat-cap-b', '/sessions', {
      chatId: 'chat-b',
    }))).resolves.toMatchObject({ code: 'subscription_limit_exceeded' });
    expect(clients.size).toBe(1);
  });

  it('rejects a mismatched persisted cursor before context or client admission', async () => {
    class WrongCursorStore extends InMemoryFeishuGatewayStore {
      override getCursor(): FeishuCursorRecord {
        return {
          instanceId: credential.instanceId,
          credentialId: credential.credentialId,
          chatId: 'wrong-chat',
          revision: 10,
          updatedAt: 1,
        };
      }
    }
    const store = new WrongCursorStore();
    store.enroll(credential);
    const { gateway, clients } = setup({ store });
    await expect(gateway.handle(messageEvent('bad-store-cursor', '/sessions'))).rejects.toMatchObject({
      code: 'invalid_configuration',
    });
    expect(store.getContext(credential.instanceId, credential.credentialId, 'chat-1')).toBeNull();
    expect(clients.size).toBe(0);
  });

  it('rejects unknown delivery-record fields before creating a context', async () => {
    class ExtraDeliveryFieldStore extends InMemoryFeishuGatewayStore {
      override claimDelivery(
        input: Omit<
          FeishuDeliveryRecord,
          'attemptDeadlineAt' | 'attempts' | 'phase' | 'status' | 'transportSafety'
        >,
        attempts: number,
        lifetime?: number,
      ): DeliveryClaim {
        const claim = super.claimDelivery(input, attempts, lifetime);
        return {
          ...claim,
          record: { ...claim.record, businessPayload: 'must-not-pass' },
        } as unknown as DeliveryClaim;
      }
    }
    const store = new ExtraDeliveryFieldStore();
    store.enroll(credential);
    const { gateway } = setup({ store });
    await expect(gateway.handle(messageEvent('bad-delivery-record', '/sessions'))).rejects.toMatchObject({
      code: 'invalid_configuration',
    });
    expect(store.getContext(credential.instanceId, credential.credentialId, 'chat-1')).toBeNull();
  });

  it('rejects a delivery claim whose state contradicts its persisted record', async () => {
    class ContradictoryClaimStore extends InMemoryFeishuGatewayStore {
      override claimDelivery(
        input: Omit<
          FeishuDeliveryRecord,
          'attemptDeadlineAt' | 'attempts' | 'phase' | 'status' | 'transportSafety'
        >,
        attempts: number,
        lifetime?: number,
      ): DeliveryClaim {
        const claim = super.claimDelivery(input, attempts, lifetime);
        return { state: 'duplicate', record: claim.record };
      }
    }
    const store = new ContradictoryClaimStore();
    store.enroll(credential);
    const { gateway } = setup({ store });
    await expect(gateway.handle(messageEvent('contradictory-claim', '/sessions'))).rejects
      .toMatchObject({ code: 'invalid_configuration' });
    expect(store.getContext(
      credential.instanceId,
      credential.credentialId,
      'chat-1',
    )).toBeNull();
  });

  it('rejects a claimed delivery that is not a fresh Core-phase attempt', async () => {
    class InvalidClaimPhaseStore extends InMemoryFeishuGatewayStore {
      override claimDelivery(
        input: Omit<
          FeishuDeliveryRecord,
          'attemptDeadlineAt' | 'attempts' | 'phase' | 'status' | 'transportSafety'
        >,
        attempts: number,
        lifetime?: number,
      ): DeliveryClaim {
        const claim = super.claimDelivery(input, attempts, lifetime);
        return { ...claim, record: { ...claim.record, phase: 'pre-transport' } };
      }
    }
    const store = new InvalidClaimPhaseStore();
    store.enroll(credential);
    const { gateway } = setup({ store });
    await expect(gateway.handle(messageEvent('invalid-claim-phase', '/sessions'))).rejects
      .toMatchObject({ code: 'invalid_configuration' });
  });
});

describe('credential recheck at Core mutation boundaries', () => {
  it('prevents runtime update when revocation occurs during its held session read', async () => {
    const { gateway, clients, store } = setup();
    await select(gateway);
    const client = onlyClient(clients);
    let release!: (value: unknown) => void;
    client.requestHook = (call) => call.method === 'session.console.get'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : undefined;
    const handling = gateway.handle(
      messageEvent('runtime-revoked', '/runtime-set 10 {"approvalPolicy":"never"}'),
    );
    await flush();
    store.enroll({ ...credential, status: 'revoked' });
    release({
      session: {
        id: 'session-1', adapterId: 'codex-cli', title: 'Session', status: 'idle',
        archived: false, createdAt: 1, updatedAt: 2,
      },
      revision: 10,
    });
    await expect(handling).resolves.toMatchObject({ code: 'revoked' });
    expect(client.calls.filter((call) => call.method === 'session.runtime.update')).toHaveLength(0);
    expect(client.closed).toBe(true);
  });

  it('prevents pending.respond when revocation occurs during the authoritative re-read', async () => {
    const { gateway, clients, store, transport } = setup();
    await select(gateway);
    const client = onlyClient(clients);
    client.pending.set('session-1', [pending()]);
    await gateway.handle(messageEvent('pending-card-before-revoke', '/pending'));
    const action = actionFrom(transport.messages.at(-1)!);
    let release!: (value: unknown) => void;
    client.requestHook = (call) => call.method === 'pending.list'
      ? new Promise((resolve) => {
          release = resolve;
        })
      : undefined;
    const handling = gateway.handle(actionEvent('pending-revoked', action));
    await flush();
    store.enroll({ ...credential, status: 'revoked' });
    release({ requests: [pending()], revision: action.revision });
    await expect(handling).resolves.toMatchObject({ code: 'revoked' });
    expect(client.calls.filter((call) => call.method === 'pending.respond')).toHaveLength(0);
  });

  it('rejects a runtime-update response for a different adapter', async () => {
    const { gateway, clients } = setup();
    await select(gateway);
    const client = onlyClient(clients);
    client.requestHook = (call) => call.method === 'session.runtime.update'
      ? {
          controls: { adapterId: 'claude-code', values: {}, revision: 11 },
          effect: 'hot-applied',
          replacementSessionId: null,
        }
      : undefined;
    expect((await gateway.handle(
      messageEvent('runtime-adapter-mismatch', '/runtime-set 10 {"approvalPolicy":"never"}'),
    )).code).toBe('invalid_core_response');
  });
});
