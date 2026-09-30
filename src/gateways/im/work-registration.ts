import { createHash } from 'node:crypto';
import { assertFeishuMethod } from './client-pool';
import { validateSubscriptionResult } from './core-output';
import type { ConnectedFeishuClient, EnrolledFeishuCredential, FeishuGatewayLimits,
  FeishuGatewayStore, NotificationEvent } from './types';

export interface WorkRegistrationResult { handled: boolean; notice?: string }

/** Provisional identity is durable before provider messages; user selection changes remain authoritative. */
export async function registerFeishuWorkEvent(input: {
  store: FeishuGatewayStore;
  credential: EnrolledFeishuCredential;
  chatId: string;
  event: NotificationEvent;
  limits: FeishuGatewayLimits;
  now(): number;
  remaining(): number;
  connected(): Promise<ConnectedFeishuClient>;
  beforeMutation(): Promise<void>;
}): Promise<WorkRegistrationResult> {
  const { store, credential: c, chatId, event } = input;
  const context = () => store.getContext(c.instanceId, c.credentialId, chatId);
  const initial = context();
  if (!initial || initial.chatType !== 'p2p') return { handled: !!event.workRegistration };
  if (event.renamedSession) {
    const { fromId, toId } = event.renamedSession;
    const old = store.getSubscription(c.instanceId, c.credentialId, chatId, fromId);
    if (old?.creation) {
      store.moveSubscription(c.instanceId, c.credentialId, chatId, fromId, toId);
      const current = context();
      if (current?.activeSessionId === fromId) store.putContext({ ...current, activeSessionId: toId });
    }
    return { handled: true };
  }
  const work = event.workRegistration;
  if (!work || !event.entityId) return { handled: false };
  const rows = store.listSubscriptions(c.instanceId, c.credentialId, chatId);
  if (initial.assistantSessionId !== work.assistantSessionId &&
    !rows.some(s => s.sessionId === work.assistantSessionId && s.purpose === 'assistant')) return { handled: true };
  const own = rows.filter(s => s.creation?.assistantSessionId === work.assistantSessionId &&
    s.creation.requestId === work.requestId);
  if (event.kind === 'feishu.work.failed') {
    for (const row of own) {
      const current = context();
      if (current?.activeSessionId === row.sessionId) store.putContext({ ...current,
        activeSessionId: row.creation!.previousWorkSessionId, updatedAt: Math.max(input.now(), current.updatedAt + 1) });
      store.removeSubscription(c.instanceId, c.credentialId, chatId, row.sessionId);
    }
    return { handled: true };
  }
  if (event.kind === 'feishu.work.registered') {
    if (store.getSubscription(c.instanceId, c.credentialId, chatId, event.entityId)) return { handled: true };
    if (rows.length >= input.limits.maxSubscriptionsPerChat) return { handled: true };
    store.putSubscription({ instanceId: c.instanceId, credentialId: c.credentialId, chatId,
      sessionId: event.entityId, purpose: 'session', status: 'active', updatedAt: input.now(),
      creation: { ...work, previousWorkSessionId: initial.activeSessionId, contextUpdatedAt: initial.updatedAt } });
    return { handled: true };
  }
  const row = store.getSubscription(c.instanceId, c.credentialId, chatId, event.entityId);
  if (!row) return { handled: true,
    notice: '新工作会话已创建，但回复通知已达上限，当前工作会话未切换。请在完整客户端管理订阅后再选择此会话。' };
  if (!row.creation) return { handled: true };
  if (!own.some(s => s.sessionId === row.sessionId)) return { handled: true };
  const connected = await input.connected();
  assertFeishuMethod(connected.hello, 'subscription.set');
  await input.beforeMutation();
  const digest = createHash('sha256').update(JSON.stringify([work.assistantSessionId, work.requestId, row.sessionId])).digest('hex');
  validateSubscriptionResult(await connected.client.request('subscription.set', {
    sessionId: row.sessionId, subscribed: row.status === 'active',
  }, { idempotencyKey: `feishu-work:${digest}`, deadlineMs: input.remaining() }), input.limits);
  const current = context();
  if (current?.assistantSessionId === work.assistantSessionId &&
    current.activeSessionId === row.creation.previousWorkSessionId && current.updatedAt === row.creation.contextUpdatedAt) {
    store.putContext({ ...current, activeSessionId: row.sessionId, updatedAt: Math.max(input.now(), current.updatedAt + 1) });
  }
  const latest = store.getSubscription(c.instanceId, c.credentialId, chatId, row.sessionId);
  if (latest?.creation?.requestId === work.requestId) {
    const { creation: _completed, ...retained } = latest;
    store.putSubscription({ ...retained, updatedAt: input.now() });
  }
  return { handled: true };
}
