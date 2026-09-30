import { createHash } from 'node:crypto';
import { FEISHU_ASSISTANT_REGISTRATION_LIMIT, parseFeishuAssistantsRegisterResult } from '@contracts/index';
import { assertFeishuMethod } from './client-pool';
import { FeishuGatewayError } from './errors';
import type { FeishuCommandExecutorOptions } from './command-executor';
import type { ConnectedFeishuClient, EnrolledFeishuCredential, FeishuChatContext,
  FeishuMessageEvent } from './types';

const registered = new WeakMap<ConnectedFeishuClient, Set<string>>();

/** Reconcile v5 purpose metadata on each new Core connection before sending assistant input. */
export async function registerFeishuAssistants(
  options: FeishuCommandExecutorOptions, event: FeishuMessageEvent, credential: EnrolledFeishuCredential,
  context: FeishuChatContext, connected: ConnectedFeishuClient, remaining: () => number,
): Promise<void> {
  if (event.chatType !== 'p2p' || !context.assistantSessionId) return;
  const ids = new Set<string>([context.assistantSessionId]);
  for (const chat of options.store.listContexts()) {
    if (chat.instanceId !== credential.instanceId || chat.credentialId !== credential.credentialId || chat.chatType !== 'p2p') continue;
    if (chat.assistantSessionId) ids.add(chat.assistantSessionId);
    for (const subscription of options.store.listSubscriptions(chat.instanceId, chat.credentialId, chat.chatId)) {
      if (subscription.purpose === 'assistant') ids.add(subscription.sessionId);
    }
  }
  const seen = registered.get(connected) ?? new Set<string>();
  const pending = [...ids].filter(id => !seen.has(id)).sort();
  if (!pending.length) return;
  assertFeishuMethod(connected.hello, 'feishu.assistants.register');
  for (let offset = 0; offset < pending.length; offset += FEISHU_ASSISTANT_REGISTRATION_LIMIT) {
    const sessionIds = pending.slice(offset, offset + FEISHU_ASSISTANT_REGISTRATION_LIMIT);
    await options.beforeMutation(credential, event.chatId);
    const digest = createHash('sha256').update(JSON.stringify([event.eventId, sessionIds])).digest('hex');
    const result = parseFeishuAssistantsRegisterResult(await connected.client.request('feishu.assistants.register',
      { sessionIds }, { idempotencyKey: `feishu-assistants:${digest}`, deadlineMs: remaining() }));
    if (result.registeredSessionIds.some(id => !sessionIds.includes(id))) {
      throw new FeishuGatewayError('invalid_core_response', 'Assistant registration returned an unexpected identity');
    }
    if (sessionIds.includes(context.assistantSessionId) && !result.registeredSessionIds.includes(context.assistantSessionId)) {
      throw new FeishuGatewayError('not_found', 'The current assistant is unavailable');
    }
    for (const id of sessionIds) seen.add(id);
    registered.set(connected, seen);
  }
}
