import { createHash } from 'node:crypto';
import { FEISHU_CONVERSATION_SETUP } from './conversation-prompt';
import { parseFeishuCommand, type FeishuCommand } from './commands';
import type { FeishuCommandExecutor } from './command-executor';
import { classifyGatewayError, FeishuGatewayError } from './errors';
import type {
  ConnectedFeishuClient, EnrolledFeishuCredential, FeishuChatContext, FeishuGatewayLimits,
  FeishuGatewayStore, FeishuMessageEvent, SessionConsoleView,
} from './types';

const TITLES: Record<FeishuCommand['kind'], string> = {
  'preferences-get': '模型配置', 'preferences-set': '选择已保存', models: '可用模型', new: '新对话',
  create: '会话已创建', directories: '工作目录', help: '使用帮助', history: '会话历史',
  pending: '待确认事项', 'runtime-get': '会话设置', 'runtime-update': '设置已更新',
  select: '当前会话', send: '消息已发送', sessions: '会话列表',
  'session-delete-confirm': '删除结果', 'session-delete-prepare': '确认删除会话',
  subscribe: '回复通知',
};

const USER_ERRORS: Record<string, string> = {
  private_configuration: '请在机器人私聊中使用保存的模型配置。',
  invalid_request: '选择的模型配置无效或已不可用。发送 /models 查看可用选项，再用 /settings 修改。',
  model_selection_required: '还没有保存模型选择。发送 /models 查看可用助手，再用 /settings chat <adapter-id> 设置聊天、/settings session <adapter-id> 设置新建会话。下次会自动沿用。',
  saved_model_unavailable: '上次选择的模型或网关暂不可用。发送 /models 查看选项，或在 Agent Deck 远端设置中调整。当前选择已保留。',
  unknown_command: '无法识别这个命令。可以直接说出需求，或发送 /help 查看命令。',
  invalid_command: '命令格式不正确。发送 /help 查看用法，也可以直接描述你的需求。',
  session_not_selected: '请先选择会话；在私聊中直接发送消息，也可以自动开始新对话。',
  not_found: '没有找到这个会话。发送 /sessions 查看可用会话。',
  capability_unavailable: '当前没有可用于此操作的模型。请在 Agent Deck 中检查模型的登录和可用状态。',
  conflict: '上次操作的结果需要确认。请发送 /sessions 查看并选择会话，避免重复创建。',
  provider_lost: '会话连接暂时不可用。请发送 /sessions 确认会话状态后再试。',
  access_denied: '当前权限不允许此操作。请在 Agent Deck 中检查会话权限。',
  subscription_limit_exceeded: '回复通知数量已达上限。请先选择不再使用的会话并发送 /unsubscribe。',
};

function key(...parts: Array<string | number>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export class FeishuConversationRouter {
  constructor(
    private readonly executor: FeishuCommandExecutor,
    private readonly store: FeishuGatewayStore,
    private readonly limits: FeishuGatewayLimits,
  ) {}

  async execute(
    event: FeishuMessageEvent,
    credential: EnrolledFeishuCredential,
    connected: ConnectedFeishuClient,
    remaining: () => number,
  ): Promise<SessionConsoleView> {
    try { return await this.executeOpen(event, credential, connected, remaining); }
    catch (error) {
      const classified = classifyGatewayError(error);
      if (classified.retryable || !USER_ERRORS[classified.code]) throw error;
      const message = classified.code === 'conflict' && event.text.trimStart().startsWith('/settings')
        ? '配置已发生变化。请发送 /settings 查看最新选择，再重新设置。' : USER_ERRORS[classified.code];
      return { text: message, revision: null, errorCode: classified.code,
        presentation: { title: '暂时无法完成', standalone: event.chatType === 'p2p' } };
    }
  }

  private async executeOpen(
    event: FeishuMessageEvent, credential: EnrolledFeishuCredential,
    connected: ConnectedFeishuClient, remaining: () => number,
  ): Promise<SessionConsoleView> {
    let command = parseFeishuCommand(event.text, this.limits.maxTextBytes);
    const context = (): FeishuChatContext => {
      const value = this.store.getContext(credential.instanceId, credential.credentialId, event.chatId);
      if (!value) throw new FeishuGatewayError('invalid_configuration', 'Chat context is missing');
      return value;
    };
    const run = (value: FeishuCommand, source = event): Promise<SessionConsoleView> =>
      this.executor.execute(value, source, credential, context(), connected, remaining);
    const subscribe = async (force: boolean): Promise<void> => {
      const sessionId = context().activeSessionId;
      if (!sessionId) return;
      const current = this.store.getSubscription(credential.instanceId, credential.credentialId, event.chatId, sessionId);
      if (current?.status === 'active' || (current && !force)) return;
      await run({ kind: 'subscribe', subscribed: true }, {
        ...event, eventId: `subscribe-${key(event.eventId, sessionId)}`,
      });
    };

    if (command.kind === 'new' && event.chatType === 'p2p') {
      command = { kind: 'create', adapterId: null, purpose: 'conversation', workingDirectory: '.', initialMessage: FEISHU_CONVERSATION_SETUP };
    }
    if (command.kind === 'send' && !context().activeSessionId && event.chatType === 'p2p') {
      const current = context();
      const subscriptions = this.store.listSubscriptions(credential.instanceId, credential.credentialId, event.chatId);
      if (subscriptions.length >= this.limits.maxSubscriptionsPerChat) {
        throw new FeishuGatewayError('subscription_limit_exceeded', 'Chat subscriptions are full');
      }
      // The setup is independent of user text, so a lost create response can be recovered by the
      // next message using the same Core idempotency key, without persisting message bodies here.
      await run({ kind: 'create', adapterId: null, purpose: 'conversation', workingDirectory: '.', initialMessage: FEISHU_CONVERSATION_SETUP }, {
        ...event,
        eventId: `conversation-${key(credential.instanceId, credential.credentialId, event.chatId, current.updatedAt)}`,
      });
    }
    if (command.kind === 'send' && event.chatType === 'p2p') await subscribe(false);
    const result = await run(command);
    if (event.chatType === 'p2p' && command.kind === 'create') await subscribe(true);
    const selected = context().activeSessionId;
    const subscribed = selected && this.store.getSubscription(
      credential.instanceId, credential.credentialId, event.chatId, selected,
    )?.status === 'active';
    if (command.kind === 'send' && event.chatType === 'p2p' && !event.text.trimStart().startsWith('/')) {
      return subscribed ? { ...result, silent: true }
        : { ...result, text: '消息已发送。回复通知已关闭，发送 /subscribe 可以恢复。' };
    }
    return {
      ...result,
      presentation: { title: TITLES[command.kind], standalone: event.chatType === 'p2p' },
    };
  }
}
