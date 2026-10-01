import { createHash } from 'node:crypto';
import { FEISHU_CONVERSATION_SETUP, FEISHU_WORK_SESSION_SETUP } from './conversation-prompt';
import { parseFeishuCommand, type FeishuCommand } from './commands';
import type { FeishuCommandExecutor } from './command-executor';
import { classifyGatewayError, FeishuGatewayError } from './errors';
import { feishuSessionFooter, feishuWorkName, readFeishuSessionTitle } from './session-names';
import type {
  ConnectedFeishuClient, EnrolledFeishuCredential, FeishuChatContext, FeishuGatewayLimits,
  FeishuGatewayStore, FeishuMessageEvent, SessionConsoleView,
} from './types';

const TITLES: Record<FeishuCommand['kind'], string> = {
  'preferences-get': '聊天与工作会话配置', 'preferences-set': '选择已保存', models: '可用配置', new: '新建工作会话', 'new-conversation': '新聊天',
  create: '会话已创建', directories: '工作目录', help: '使用帮助', history: '会话历史',
  pending: '待确认事项', rename: '名称已更新', 'runtime-get': '会话设置', 'runtime-update': '设置已更新',
  select: '当前会话', send: '消息已发送', sessions: '会话列表',
  'session-delete-confirm': '删除结果', 'session-delete-prepare': '确认删除会话',
  subscribe: '回复通知',
};

const USER_ERRORS: Record<string, string> = {
  private_configuration: '请在机器人私聊中使用保存的模型配置。',
  invalid_request: '选择的模型配置无效或已不可用。发送 /models 查看可用选项，再用 /settings 修改。',
  model_selection_required: '还没有选择机器人助手。发送 /models 查看可用助手，再用 /settings chat <adapter-id> 设置，或在 Agent Deck 远端设置中选择。',
  saved_model_unavailable: '上次选择的模型或网关暂不可用。发送 /models 查看选项，或在 Agent Deck 远端设置中调整。当前选择已保留。',
  unknown_command: '无法识别这个命令。可以直接说出需求，或发送 /help 查看命令。',
  invalid_command: '命令格式不正确。发送 /help 查看用法，也可以直接描述你的需求。',
  session_not_selected: '尚未选择工作会话。发送 /new [需求] 新建，或用 /sessions 查看后 /select <ID> 选择。普通文字始终发给助手。',
  assistant_not_started: '助手还没有聊天记录，直接发送文字即可开始。',
  session_target_mismatch: '助手聊天与工作会话分别选择：/chat list、/chat select <ID> 用于助手；/sessions、/select <ID> 用于工作会话。',
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
    private readonly now: () => number = Date.now,
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
      let message = classified.code === 'conflict' && event.text.trimStart().startsWith('/settings')
        ? '配置已发生变化。请发送 /settings 查看最新选择，再重新设置。' : USER_ERRORS[classified.code];
      const text = event.text.trimStart();
      const source = !text.startsWith('/') || text.startsWith('/chat ') ? '助手'
        : /^\/(new|create|select|send|history|runtime|pending|delete|subscribe|unsubscribe|rename)\b/.test(text) ? '工作会话' : 'Agent Deck';
      if (source === '助手' && classified.code === 'not_found') {
        message = '没有找到这段助手聊天。发送 /chat list 查看已保留的聊天，或 /chat new 开始新聊天。';
      }
      if (source === '工作会话' && classified.code === 'model_selection_required') {
        message = '首次创建请告诉机器人要使用哪种助手，也可以用 /models 查看选项后发送 /create <adapter-id> . -- <需求>。之后 /new 会自动沿用上次选择。';
      }
      if (source === '工作会话' && classified.code === 'saved_model_unavailable') {
        message = '上次选择暂不可用，已为你保留。请告诉机器人这次要使用的助手和模型，或用 /models 查看选项后通过 /create 重新选择。';
      }
      return { text: message, revision: null, errorCode: classified.code,
        presentation: { title: `${source} · 暂时无法完成`, standalone: event.chatType === 'p2p' } };
    }
  }

  private async executeOpen(
    event: FeishuMessageEvent, credential: EnrolledFeishuCredential,
    connected: ConnectedFeishuClient, remaining: () => number,
  ): Promise<SessionConsoleView> {
    let command = parseFeishuCommand(event.text, this.limits.maxTextBytes);
    let initializedAssistant = false;
    const context = (): FeishuChatContext => {
      const value = this.store.getContext(credential.instanceId, credential.credentialId, event.chatId);
      if (!value) throw new FeishuGatewayError('invalid_configuration', 'Chat context is missing');
      return value;
    };
    const ordinaryChat = command.kind === 'send' && event.chatType === 'p2p' && !event.text.trimStart().startsWith('/');
    const assistantTarget = ordinaryChat || command.target === 'assistant' || command.kind === 'new-conversation';
    if (assistantTarget && event.chatType !== 'p2p') {
      throw new FeishuGatewayError('private_configuration', 'Assistant conversations are private');
    }
    const run = (value: FeishuCommand, source = event, sessionId?: string | null): Promise<SessionConsoleView> => {
      const stored = context();
      return this.executor.execute(value, source, credential,
        sessionId === undefined ? stored : { ...stored, activeSessionId: sessionId }, connected, remaining);
    };
    const subscribe = async (sessionId: string | null, force: boolean): Promise<void> => {
      if (!sessionId) return;
      const current = this.store.getSubscription(credential.instanceId, credential.credentialId, event.chatId, sessionId);
      if (current?.status === 'active' || (current && !force)) return;
      await run({ kind: 'subscribe', subscribed: true }, {
        ...event, eventId: `subscribe-${key(event.eventId, sessionId)}`,
      }, sessionId);
    };
    if (command.kind === 'new' && event.chatType === 'p2p') {
      command = { kind: 'create', adapterId: null, purpose: 'session', workingDirectory: '.',
        initialMessage: command.initialMessage || FEISHU_WORK_SESSION_SETUP };
    }
    if (command.kind === 'new-conversation') {
      command = { kind: 'create', adapterId: null, purpose: 'conversation', workingDirectory: '.', initialMessage: FEISHU_CONVERSATION_SETUP };
    }
    if (ordinaryChat && !context().assistantSessionId) {
      const current = context();
      if (this.store.listSubscriptions(credential.instanceId, credential.credentialId, event.chatId).length >= this.limits.maxSubscriptionsPerChat) {
        throw new FeishuGatewayError('subscription_limit_exceeded', 'Chat subscriptions are full');
      }
      // Work selection changes cannot change the assistant's bootstrap identity.
      await run({ kind: 'create', adapterId: null, purpose: 'conversation', workingDirectory: '.', initialMessage: FEISHU_CONVERSATION_SETUP }, {
        ...event, eventId: `conversation-${key(credential.instanceId, credential.credentialId, event.chatId, current.assistantGeneration)}`,
      });
      initializedAssistant = true;
    }
    const selected = (): string | null => assistantTarget ? context().assistantSessionId : context().activeSessionId;
    if (assistantTarget && !['create', 'sessions', 'select'].includes(command.kind) && !selected()) {
      throw new FeishuGatewayError('assistant_not_started', 'No assistant conversation has started');
    }
    if (command.kind === 'send' && event.chatType === 'p2p') await subscribe(selected(), false);
    if (assistantTarget && command.kind === 'send') {
      await this.executor.registerAssistants(event, credential, context(), connected, remaining);
      await this.executor.refreshAssistantSetup(event, credential, context(), connected, remaining, initializedAssistant);
    }
    if (assistantTarget && command.kind === 'runtime-update' && context().assistantGeneration === Number.MAX_SAFE_INTEGER &&
      ('claudeCodeSandbox' in command.patch || 'grokSandbox' in command.patch)) {
      throw new FeishuGatewayError('conflict', 'Assistant generation is exhausted');
    }
    const previousTarget = selected();
    let result = await run(command, event, ['create', 'select'].includes(command.kind) ? undefined : previousTarget);
    if (command.kind === 'runtime-update' && result.replacementSessionId &&
      result.replacementSessionId !== previousTarget && previousTarget && selected() === previousTarget) {
      const current = context();
      const previous = this.store.getSubscription(credential.instanceId, credential.credentialId, event.chatId, previousTarget);
      this.store.putContext({ ...current, updatedAt: this.now(), ...(assistantTarget ? {
        assistantSessionId: result.replacementSessionId, assistantGeneration: current.assistantGeneration + 1,
      } : { activeSessionId: result.replacementSessionId }) });
      if (previous) {
        this.store.putSubscription({ ...previous, status: 'inactive', updatedAt: this.now() });
        // Preserve explicit unsubscribe across provider replacements, including older assistant histories.
        // A new provider identity may have a fresh context; initialize its assistant rules on the next turn.
        const { assistantSetupVersion: _oldSetup, creation: _oldCreation, ...retained } = previous;
        this.store.putSubscription({ ...retained, sessionId: result.replacementSessionId, status: 'inactive', updatedAt: this.now() });
      }
      try {
        if (event.chatType === 'p2p' && previous?.status === 'active') await subscribe(selected(), true);
        if (assistantTarget) await this.executor.registerAssistants(event, credential, context(), connected, remaining);
      } catch {
        // The provider replacement committed. Never retry it against the new selected identity.
        result = { ...result, text: `${result.text}\n回复连接需要恢复。请发送 ${assistantTarget ? '/chat subscribe' : '/subscribe'} 后继续。` };
      }
    }
    if (event.chatType === 'p2p' && command.kind === 'create') await subscribe(selected(), true);
    if (assistantTarget && command.kind === 'select') await subscribe(selected(), true);
    if (assistantTarget && ['create', 'select'].includes(command.kind)) {
      await this.executor.registerAssistants(event, credential, context(), connected, remaining);
      await this.executor.refreshAssistantSetup(event, credential, context(), connected, remaining, command.kind === 'create');
    }
    const sessionId = selected();
    const subscribed = sessionId && this.store.getSubscription(
      credential.instanceId, credential.credentialId, event.chatId, sessionId,
    )?.status === 'active';
    if (command.kind === 'send' && event.chatType === 'p2p') {
      // Core may accept a send whose response is lost. A later callback retry must not
      // append an obsolete receipt after its subscribed provider reply has arrived.
      if (subscribed) return { ...result, silent: true };
      const text = assistantTarget
        ? '消息已发送。助手回复通知已关闭，发送 /chat subscribe 可以恢复。'
        : '消息已发送。工作会话回复通知已关闭，发送 /subscribe 可以恢复。';
      result = { ...result, text };
      if (ordinaryChat) return result;
    }
    const sessionScoped = ['create', 'select', 'send', 'history', 'pending', 'runtime-get', 'runtime-update', 'rename',
      'subscribe', 'session-delete-prepare', 'session-delete-confirm'].includes(command.kind);
    const title = !assistantTarget && sessionScoped && sessionId && event.chatType === 'p2p'
      ? await readFeishuSessionTitle(connected, sessionId, this.limits, remaining) : null;
    const source = assistantTarget ? '助手' : sessionScoped ? feishuWorkName(title) : 'Agent Deck';
    return { ...result, ...(title && sessionId ? { sessionTitles: { [sessionId]: title } } : {}),
      presentation: { title: `${source} · ${TITLES[command.kind]}`, standalone: event.chatType === 'p2p',
      ...(!assistantTarget && sessionScoped && sessionId && event.chatType === 'p2p'
        ? { footer: feishuSessionFooter(sessionId) } : {}) } };
  }
}
