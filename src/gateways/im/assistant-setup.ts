import { createHash } from 'node:crypto';
import { FEISHU_ASSISTANT_SETUP_VERSION, FEISHU_CONVERSATION_UPDATE } from './conversation-prompt';
import { assertFeishuMethod } from './client-pool';
import { validateSendResult } from './core-output';
import type { FeishuCommandExecutorOptions } from './command-executor';
import type { ConnectedFeishuClient, EnrolledFeishuCredential, FeishuChatContext, FeishuMessageEvent } from './types';

/** One recorded update per assistant, including after a gateway restart or selection of old history. */
export async function refreshFeishuAssistantSetup(options: FeishuCommandExecutorOptions,
  event: FeishuMessageEvent, credential: EnrolledFeishuCredential, context: FeishuChatContext,
  connected: ConnectedFeishuClient, remaining: () => number, initialized: boolean): Promise<void> {
  const sessionId = context.assistantSessionId;
  if (event.chatType !== 'p2p' || !sessionId) return;
  const read = () => options.store.getSubscription(credential.instanceId, credential.credentialId, event.chatId, sessionId);
  const current = read();
  if (!current || current.purpose !== 'assistant' || (current.assistantSetupVersion ?? 0) >= FEISHU_ASSISTANT_SETUP_VERSION) return;
  if (!initialized) {
    assertFeishuMethod(connected.hello, 'session.send');
    await options.beforeMutation(credential, event.chatId);
    const digest = createHash('sha256').update(JSON.stringify([sessionId, FEISHU_ASSISTANT_SETUP_VERSION])).digest('hex');
    validateSendResult(await connected.client.request('session.send', {
      sessionId, text: FEISHU_CONVERSATION_UPDATE,
    }, { idempotencyKey: `feishu-assistant-setup:${digest}`, deadlineMs: remaining() }), options.limits);
  }
  const latest = read();
  if (latest?.purpose === 'assistant') options.store.putSubscription({ ...latest,
    assistantSetupVersion: FEISHU_ASSISTANT_SETUP_VERSION, updatedAt: options.now() });
}
