import { describe, expect, it } from 'vitest';
import type {
  FeishuDeliveryAttemptContext,
  FeishuOutboundMessage,
  FeishuTransportPort,
} from '.';
import {
  FakeTransport,
  actionEvent,
  actionFrom,
  credential,
  messageEvent,
  onlyClient,
  pending,
  select,
  setup,
} from './__tests__/fixture';

class AcceptedThenThrowTransport implements FeishuTransportPort {
  readonly deliverySemantics = 'unknown' as const;
  readonly accepted: FeishuOutboundMessage[] = [];
  armedEventId: string | null = null;

  async deliver(
    message: FeishuOutboundMessage,
    context: FeishuDeliveryAttemptContext,
  ): Promise<void> {
    context.remainingMs();
    this.accepted.push(structuredClone(message));
    if (message.eventId === this.armedEventId) {
      throw new Error('provider accepted before connection loss');
    }
  }
}

describe('logical event attempt and reconciliation policy', () => {
  it('exhausts the total provider replay budget without overflow or further Core work', async () => {
    const transport = new FakeTransport();
    const { gateway, clients, store } = setup({
      transport,
      limits: {
        maxTransportAttemptsPerCallback: 1,
        maxEventAttempts: 2,
      },
    });
    await select(gateway);
    transport.failures = 100;
    const event = messageEvent('event-budget', '/send bounded-replay');
    await expect(gateway.handle(event)).rejects.toMatchObject({ code: 'delivery_failed' });
    await expect(gateway.handle(event)).rejects.toMatchObject({ code: 'delivery_failed' });
    await expect(gateway.handle(event)).resolves.toMatchObject({ code: 'delivery_exhausted' });
    await expect(gateway.handle(event)).resolves.toMatchObject({ code: 'delivery_exhausted' });
    expect(store.getDelivery(credential.instanceId, event.eventId)).toMatchObject({
      attempts: 2,
      status: 'exhausted',
    });
    expect(onlyClient(clients).calls.filter((call) => call.method === 'session.send')).toHaveLength(
      2,
    );
    expect(transport.attempts).toHaveLength(3);
  });

  it('never retries accepted-then-throw without an idempotent transport contract', async () => {
    const transport = new AcceptedThenThrowTransport();
    const { gateway, clients, store } = setup({ transport });
    await select(gateway);
    transport.armedEventId = 'accepted-then-throw';
    const event = messageEvent('accepted-then-throw', '/send once');
    await expect(gateway.handle(event)).rejects.toMatchObject({ code: 'delivery_ambiguous' });
    expect(store.getDelivery(credential.instanceId, event.eventId)?.status).toBe('reconciling');
    await expect(gateway.handle(event)).resolves.toMatchObject({
      code: 'reconciliation_required',
    });
    await expect(gateway.handle(event)).resolves.toMatchObject({ code: 'delivery_exhausted' });
    expect(transport.accepted.filter((message) => message.eventId === event.eventId)).toHaveLength(
      1,
    );
    expect(onlyClient(clients).calls.filter((call) => call.method === 'session.send')).toHaveLength(
      1,
    );
  });
});

describe('trustworthy approval presentation binding', () => {
  it('rejects a materially changed pending display after card issuance', async () => {
    const { gateway, clients, transport } = setup();
    await select(gateway);
    const client = onlyClient(clients);
    client.pending.set('session-1', [pending()]);
    await gateway.handle(messageEvent('digest-card', '/pending'));
    const action = actionFrom(transport.messages.at(-1)!);
    client.pending.set('session-1', [
      { ...pending(), display: { tool: 'Bash', command: 'rm -rf /different' } },
    ]);
    expect((await gateway.handle(actionEvent('digest-changed', action))).code).toBe(
      'pending_context_changed',
    );
    expect(client.calls.filter((call) => call.method === 'pending.respond')).toHaveLength(0);
  });

  it('rejects a 20KB approval context before emitting any action button', async () => {
    const { gateway, clients, transport } = setup();
    await select(gateway);
    onlyClient(clients).pending.set('session-1', [
      { ...pending(), display: { command: 'x'.repeat(20_000) } },
    ]);
    transport.messages.length = 0;
    expect((await gateway.handle(messageEvent('huge-approval-context', '/pending'))).code).toBe(
      'invalid_core_response',
    );
    expect(transport.messages).toHaveLength(0);
  });
});
