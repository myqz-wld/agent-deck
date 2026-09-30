import { defaultFeishuModelPreference, mergeFeishuModelPreference, FEISHU_PREFERENCE_OPTION_KEYS, SESSION_CONSOLE_CREATE_OPTION_KEYS,
  type SessionConsoleCreateOptions } from '@contracts/index';
import type { FeishuCommandExecutorOptions } from './command-executor';
import type { FeishuCommand } from './commands';
import { assertFeishuMethod } from './client-pool';
import { validateSessionConsoleCreateResult } from './core-output';
import { FeishuGatewayError } from './errors';
import { readModelCapabilities, readPreferences, savePreference } from './preferences';
import type { ConnectedFeishuClient, EnrolledFeishuCredential, FeishuChatContext, FeishuMessageEvent,
  SessionConsoleView } from './types';

export async function createFeishuSession(options: FeishuCommandExecutorOptions,
  command: Extract<FeishuCommand, { kind: 'create' }>, event: FeishuMessageEvent,
  credential: EnrolledFeishuCredential, context: FeishuChatContext, connected: ConnectedFeishuClient,
  remaining: () => number): Promise<SessionConsoleView> {
  assertFeishuMethod(connected.hello, 'session.console.create');
  await options.beforeMutation(credential, event.chatId);
  const purpose = command.purpose ?? 'session';
  if (purpose === 'conversation' && context.assistantGeneration === Number.MAX_SAFE_INTEGER) {
    throw new FeishuGatewayError('conflict', 'Assistant generation is exhausted');
  }
  if (event.chatType === 'p2p' && options.store.listSubscriptions(
    credential.instanceId, credential.credentialId, event.chatId,
  ).length >= options.limits.maxSubscriptionsPerChat) {
    throw new FeishuGatewayError('subscription_limit_exceeded', 'Chat subscriptions are full');
  }
  if (event.chatType === 'group' && !command.adapterId) {
    throw new FeishuGatewayError('private_configuration', 'Saved selections are private');
  }
  const current = event.chatType === 'group'
    ? { conversation: defaultFeishuModelPreference(), session: defaultFeishuModelPreference(), settingsRevision: 0, revision: 0 }
    : await readPreferences(connected, remaining);
  const previous = current[purpose];
  const preference = mergeFeishuModelPreference(previous, {
    ...command.selection, adapterId: command.adapterId as typeof previous.adapterId ?? previous.adapterId,
  });
  if (!preference.adapterId) throw new FeishuGatewayError('model_selection_required', 'Choose a model first');
  const capabilities = await readModelCapabilities(connected, remaining, options.limits,
    preference.adapterId, preference.provider, command.workingDirectory);
  if (!capabilities.create.enabled || capabilities.selectedAdapterId !== preference.adapterId) {
    throw new FeishuGatewayError('capability_unavailable', 'Saved adapter is unavailable');
  }
  const createOptions = Object.fromEntries(SESSION_CONSOLE_CREATE_OPTION_KEYS.map((key) => [
    key, capabilities.create.options[key].defaultValue,
  ])) as unknown as SessionConsoleCreateOptions;
  for (const key of FEISHU_PREFERENCE_OPTION_KEYS) {
    const value = preference[key];
    if (!value) continue;
    const descriptor = capabilities.create.options[key];
    if (!descriptor.enabled || (!descriptor.allowCustom && !descriptor.allowedValues?.includes(value))) {
      throw new FeishuGatewayError('saved_model_unavailable', 'Saved model option is unavailable');
    }
    createOptions[key] = value;
  }
  // Save an explicit choice before dispatch; a provider startup failure must not forget it.
  if (event.chatType === 'p2p' && (command.adapterId || Object.keys(command.selection ?? {}).length)) {
    await options.beforeMutation(credential, event.chatId);
    await savePreference(connected, remaining, current, purpose, preference, event.eventId);
  }
  await options.beforeMutation(credential, event.chatId);
  const result = validateSessionConsoleCreateResult(await connected.client.request('session.console.create', {
    adapterId: preference.adapterId, attachments: [], capabilityRevision: capabilities.capabilityRevision,
    initialMessage: command.initialMessage, projectTrust: { revision: capabilities.projectTrust.revision, grant: false },
    workingDirectory: command.workingDirectory, options: createOptions,
  }, { idempotencyKey: `feishu:${event.eventId}`, deadlineMs: remaining() }), options.limits);
  options.store.putContext({ ...context, updatedAt: options.now(),
    ...(purpose === 'conversation' ? {
      assistantSessionId: result.sessionId,
      assistantGeneration: context.assistantGeneration + Number(context.assistantSessionId !== result.sessionId),
    } : { activeSessionId: result.sessionId }),
  });
  const processing = { sessionId: result.sessionId, afterRevision: capabilities.revision };
  if (event.chatType === 'group') return { text: '会话已创建。请在机器人私聊中查看详情。', revision: result.revision, processing };
  return { text: `${purpose === 'conversation' ? '机器人助手' : '工作会话'}：${capabilities.create.displayName}\n模型：${createOptions.model || '跟随原生设置'} · ${createOptions.thinking}\n工作目录：${command.workingDirectory}\nID：${result.sessionId}\n\n${purpose === 'conversation' ? '直接发送文字即可与助手聊天。' : '使用 /send <内容> 向此会话发送消息。普通文字仍发给助手。'}`, revision: result.revision, processing };
}
