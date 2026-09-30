import { createFeishuSession } from './session-create';
import { mergeFeishuModelPreference, parseSessionNameUpdateResult } from '@contracts/index';
import { registerFeishuAssistants } from './assistant-registration';
import { refreshFeishuAssistantSetup } from './assistant-setup';
import { readModelCapabilities, readPreferences, renderModels, renderPreferences, savePreference } from './preferences';
import { FEISHU_HELP_TEXT, type FeishuCommand } from './commands';
import { assertFeishuMethod } from './client-pool';
import {
  validateHistoryResult,
  validatePendingListResult,
  validateRuntimeUpdateResult,
  validateSendResult,
  validateSubscriptionResult,
  validateProjectListResult,
  validateRuntimeControls,
  validateSessionConsoleGetResult,
  validateSessionConsoleListResult,
} from './core-output';
import { FeishuGatewayError } from './errors';
import {
  renderHistory,
  renderPending,
  renderDirectoryList,
  renderRuntime,
  renderSessionList,
  type RenderContext,
} from './render';
import { truncateUtf8 } from './redaction';
import { assertAdapterOwnedRuntimePatch } from './runtime-policy';
import { FeishuSessionDeleteController } from './session-delete';
import type {
  ConnectedFeishuClient,
  EnrolledFeishuCredential,
  FeishuChatContext,
  FeishuGatewayLimits,
  FeishuGatewayStore,
  FeishuMessageEvent,
  PendingActionNoncePort,
  SessionConsoleView,
} from './types';

export interface FeishuCommandExecutorOptions {
  store: FeishuGatewayStore;
  nonce: PendingActionNoncePort;
  limits: FeishuGatewayLimits;
  pendingPresentationLifetimeMs: number;
  now(): number;
  beforeMutation(credential: EnrolledFeishuCredential, chatId: string): Promise<void>;
}

function selectedSession(context: FeishuChatContext): string {
  if (!context.activeSessionId) {
    throw new FeishuGatewayError('session_not_selected', '请先使用 /select 选择 session');
  }
  return context.activeSessionId;
}

export class FeishuCommandExecutor {
  private readonly subscriptionTails = new Map<string, Promise<void>>();
  private readonly deleteController: FeishuSessionDeleteController;

  constructor(private readonly options: FeishuCommandExecutorOptions) {
    this.deleteController = new FeishuSessionDeleteController(options);
  }

  registerAssistants(event: FeishuMessageEvent, credential: EnrolledFeishuCredential,
    context: FeishuChatContext, connected: ConnectedFeishuClient, remaining: () => number): Promise<void> {
    return registerFeishuAssistants(this.options, event, credential, context, connected, remaining);
  }

  refreshAssistantSetup(event: FeishuMessageEvent, credential: EnrolledFeishuCredential,
    context: FeishuChatContext, connected: ConnectedFeishuClient, remaining: () => number,
    initialized = false): Promise<void> {
    return refreshFeishuAssistantSetup(this.options, event, credential, context, connected, remaining, initialized);
  }

  async execute(
    command: FeishuCommand,
    event: FeishuMessageEvent,
    credential: EnrolledFeishuCredential,
    context: FeishuChatContext,
    connected: ConnectedFeishuClient,
    remaining: () => number,
  ): Promise<SessionConsoleView> {
    const client = connected.client;
    const mutation = {
      idempotencyKey: `feishu:${event.eventId}`,
    };
    if (command.kind === 'help') return { text: FEISHU_HELP_TEXT, revision: null };
    if (command.kind === 'sessions') {
      if (event.chatType === 'group') {
        return {
          text: '群聊中已隐藏 session 列表。请使用完整客户端查看。',
          revision: null,
        };
      }
      assertFeishuMethod(connected.hello, 'session.console.list');
      const raw = await client.request(
        'session.console.list',
        {
          ...(command.cursor ? { cursor: command.cursor } : {}),
          limit: this.options.limits.maxSessions,
        },
        { deadlineMs: remaining() },
      );
      const result = validateSessionConsoleListResult(
        raw,
        this.options.limits.maxSessions,
        this.options.limits,
      );
      const assistantIds = new Set(this.options.store.listSubscriptions(
        credential.instanceId, credential.credentialId, event.chatId,
      ).filter(s => s.purpose === 'assistant').map(s => s.sessionId));
      if (context.assistantSessionId) assistantIds.add(context.assistantSessionId);
      return renderSessionList(
        result.sessions.filter(s => assistantIds.has(s.id) === (command.target === 'assistant')),
        result.nextCursor,
        assistantIds.size > 0 || command.target === 'assistant' ? null : result.total,
        this.options.limits.maxOutputBytes,
        result.revision,
        command.target === 'assistant' ? 'assistant' : 'session',
      );
    }
    if (command.kind === 'directories') {
      if (event.chatType === 'group') {
        return {
          text: '群聊中已隐藏工作目录建议。请使用完整客户端查看。',
          revision: null,
        };
      }
      assertFeishuMethod(connected.hello, 'project.list');
      const raw = await client.request(
        'project.list',
        {
          ...(command.cursor ? { cursor: command.cursor } : {}),
          limit: this.options.limits.maxProjects,
        },
        { deadlineMs: remaining() },
      );
      const result = validateProjectListResult(
        raw,
        this.options.limits.maxProjects,
        this.options.limits,
      );
      return renderDirectoryList(
        result.projects,
        result.nextCursor,
        result.total,
        this.options.limits.maxOutputBytes,
        result.revision,
      );
    }
    if (command.kind === 'select') {
      assertFeishuMethod(connected.hello, 'session.console.get');
      const raw = await client.request(
        'session.console.get',
        { sessionId: command.sessionId },
        { deadlineMs: remaining() },
      );
      const result = validateSessionConsoleGetResult(
        raw,
        command.sessionId,
        this.options.limits,
      );
      if (!result.session) throw new FeishuGatewayError('not_found', 'Session 不存在');
      const known = this.options.store.getSubscription(credential.instanceId, credential.credentialId,
        event.chatId, command.sessionId);
      if ((known?.purpose === 'assistant' || context.assistantSessionId === command.sessionId) !== (command.target === 'assistant')) {
        throw new FeishuGatewayError('session_target_mismatch', 'The selected session has a different purpose');
      }
      if (command.target === 'assistant' && context.assistantGeneration === Number.MAX_SAFE_INTEGER) {
        throw new FeishuGatewayError('conflict', 'Assistant generation is exhausted');
      }
      assertFeishuMethod(connected.hello, 'pending.list');
      const pending = await client.request(
        'pending.list',
        { sessionId: command.sessionId },
        { deadlineMs: remaining() },
      );
      const pendingResult = validatePendingListResult(
        pending, command.sessionId, this.options.limits,
      );
      const view = renderPending(
        pendingResult.requests.filter((item) => item.status === 'pending'),
        this.renderContext(credential, event.chatId, event.chatType, command.sessionId),
        pendingResult.revision,
      );
      this.options.store.putContext({
        ...context,
        ...(command.target === 'assistant' ? { assistantSessionId: command.sessionId,
          assistantGeneration: context.assistantGeneration + Number(context.assistantSessionId !== command.sessionId) }
          : { activeSessionId: command.sessionId }),
        updatedAt: Math.max(this.options.now(), context.updatedAt + 1),
      });
      return {
        ...view,
        text: truncateUtf8(
          `${result.session.title ?? '未命名会话'}\nID：${command.sessionId}\n\n${view.cards?.length ? view.text : command.target === 'assistant'
            ? '已切回助手聊天，直接发送文字即可继续。' : '使用 /send <内容> 向此工作会话发送消息。普通文字仍发给助手。'}`,
          this.options.limits.maxOutputBytes,
        ),
      };
    }
    if (command.kind === 'create') {
      return createFeishuSession(this.options, command, event, credential, context, connected, remaining);
    }
    if (command.kind === 'new' || command.kind === 'new-conversation') throw new FeishuGatewayError('invalid_command', '请在私聊中开始新对话');
    if (command.kind === 'preferences-get' || command.kind === 'preferences-set' || command.kind === 'models') {
      if (event.chatType === 'group') return { text: '请在机器人私聊中查看或修改模型配置。', revision: null };
      if (command.kind === 'models') return renderModels(await readModelCapabilities(connected,
        remaining, this.options.limits, command.adapterId, command.provider), this.options.limits.maxOutputBytes);
      const current = await readPreferences(connected, remaining);
      if (command.kind === 'preferences-get') return renderPreferences(current);
      await this.options.beforeMutation(credential, event.chatId);
      return renderPreferences(await savePreference(connected, remaining, current,
        command.purpose, mergeFeishuModelPreference(current[command.purpose], command.preference), event.eventId));
    }
    if (command.kind === 'session-delete-prepare') {
      return this.deleteController.prepare(event, credential, context, connected, remaining);
    }
    if (command.kind === 'session-delete-confirm') {
      return this.deleteController.confirm(
        command.token,
        event,
        credential,
        connected,
        remaining,
      );
    }

    const sessionId = selectedSession(context);
    if (command.kind === 'rename') {
      assertFeishuMethod(connected.hello, 'session.console.get');
      assertFeishuMethod(connected.hello, 'session.name.update');
      const current = validateSessionConsoleGetResult(await client.request('session.console.get',
        { sessionId }, { deadlineMs: remaining() }), sessionId, this.options.limits);
      if (!current.session) throw new FeishuGatewayError('not_found', 'Session 不存在');
      await this.options.beforeMutation(credential, event.chatId);
      const result = parseSessionNameUpdateResult(await client.request('session.name.update', {
        sessionId, title: command.title, expectedTitle: current.session.title,
      }, { ...mutation, deadlineMs: remaining() }));
      if (result.sessionId !== sessionId || result.title !== command.title) {
        throw new FeishuGatewayError('invalid_core_response', 'Name update returned an unexpected target');
      }
      return { text: `会话名称已改为「${result.title}」。`, revision: result.revision };
    }
    if (command.kind === 'history') {
      if (event.chatType === 'group') {
        return {
          text: '群聊中已隐藏 history 内容。请使用完整客户端查看。',
          revision: null,
        };
      }
      assertFeishuMethod(connected.hello, 'session.history');
      const raw = await client.request(
        'session.history',
        {
          sessionId,
          ...(command.cursor ? { cursor: command.cursor } : {}),
          limit: this.options.limits.maxHistoryEntries,
        },
        { deadlineMs: remaining() },
      );
      const result = validateHistoryResult(raw, sessionId, this.options.limits);
      return renderHistory(
        result.entries.slice(0, this.options.limits.maxHistoryEntries),
        result.nextCursor,
        this.options.limits.maxOutputBytes,
        result.revision,
        event.chatType,
        command.target === 'assistant' ? '/chat history' : '/history',
      );
    }
    if (command.kind === 'send') {
      assertFeishuMethod(connected.hello, 'session.send');
      await this.options.beforeMutation(credential, event.chatId);
      const raw = await client.request(
        'session.send',
        { sessionId, text: command.text },
        { ...mutation, deadlineMs: remaining() },
      );
      const result = validateSendResult(raw, this.options.limits);
      return {
        text: '消息已发送。',
        revision: result.revision,
      };
    }
    if (command.kind === 'pending') {
      assertFeishuMethod(connected.hello, 'pending.list');
      const raw = await client.request(
        'pending.list',
        { sessionId },
        { deadlineMs: remaining() },
      );
      const result = validatePendingListResult(raw, sessionId, this.options.limits);
      return renderPending(
        result.requests.filter((item) => item.status === 'pending'),
        this.renderContext(credential, event.chatId, event.chatType, sessionId),
        result.revision,
      );
    }
    if (command.kind === 'runtime-get') {
      if (event.chatType === 'group') {
        return {
          text: '群聊中已隐藏 runtime 值。请使用完整客户端查看。',
          revision: null,
        };
      }
      assertFeishuMethod(connected.hello, 'session.runtime.get');
      const result = await client.request(
        'session.runtime.get',
        { sessionId },
        { deadlineMs: remaining() },
      );
      return renderRuntime(
        validateRuntimeControls(result, this.options.limits),
        this.options.limits.maxOutputBytes,
        event.chatType,
        command.target === 'assistant' ? 'assistant' : 'session',
      );
    }
    if (command.kind === 'runtime-update') {
      assertFeishuMethod(connected.hello, 'session.console.get');
      const rawSession = await client.request(
        'session.console.get',
        { sessionId },
        { deadlineMs: remaining() },
      );
      const session = validateSessionConsoleGetResult(
        rawSession,
        sessionId,
        this.options.limits,
      );
      if (!session.session) throw new FeishuGatewayError('not_found', 'Session 不存在');
      const validatedSession = session.session;
      assertAdapterOwnedRuntimePatch(validatedSession.adapterId, command.patch);
      assertFeishuMethod(connected.hello, 'session.runtime.update');
      await this.options.beforeMutation(credential, event.chatId);
      const raw = await client.request(
        'session.runtime.update',
        { sessionId, patch: command.patch },
        {
          ...mutation,
          expectedRevision: command.expectedRevision,
          deadlineMs: remaining(),
        },
      );
      const result = validateRuntimeUpdateResult(raw, this.options.limits);
      const controls = result.controls;
      if (controls.adapterId !== validatedSession.adapterId) {
        throw new FeishuGatewayError(
          'invalid_core_response',
          'Runtime response adapter does not match the selected session',
        );
      }
      const replacement = result.replacementSessionId && event.chatType === 'p2p'
        ? `；replacement session ${result.replacementSessionId}`
        : '';
      return {
        text: `当前${command.target === 'assistant' ? '聊天助手' : '工作会话'}的设置已更新：${result.effect}${replacement}\n新建默认配置保持不变；发送 /settings 可查看。`,
        revision: controls.revision,
        replacementSessionId: result.replacementSessionId,
      };
    }

    return this.serializeSubscription(credential, event.chatId, async () => {
      remaining();
      const subscriptions = this.options.store.listSubscriptions(
        credential.instanceId,
        credential.credentialId,
        event.chatId,
      );
      const alreadyActive = subscriptions.some(
        (subscription) => subscription.sessionId === sessionId && subscription.status === 'active',
      );
      const alreadyKnown = subscriptions.some(
        (subscription) => subscription.sessionId === sessionId,
      );
      const activeCount = subscriptions.filter(
        (subscription) => subscription.status === 'active',
      ).length;
      if (
        (!alreadyKnown && subscriptions.length >= this.options.limits.maxSubscriptionsPerChat) ||
        (command.subscribed &&
          !alreadyActive &&
          activeCount >= this.options.limits.maxSubscriptionsPerChat)
      ) {
        throw new FeishuGatewayError(
          'subscription_limit_exceeded',
          'Per-chat subscription limit reached',
        );
      }
      assertFeishuMethod(connected.hello, 'subscription.set');
      await this.options.beforeMutation(credential, event.chatId);
      const raw = await client.request(
        'subscription.set',
        { sessionId, subscribed: command.subscribed },
        { ...mutation, deadlineMs: remaining() },
      );
      const result = validateSubscriptionResult(raw, this.options.limits);
      const revision = result.revision;
      this.options.store.putSubscription({
        ...subscriptions.find(s => s.sessionId === sessionId),
        instanceId: credential.instanceId,
        credentialId: credential.credentialId,
        chatId: event.chatId,
        sessionId,
        purpose: subscriptions.find(s => s.sessionId === sessionId)?.purpose ??
          (context.assistantSessionId === sessionId ? 'assistant' : 'session'),
        status: result.subscribed ? 'active' : 'inactive',
        updatedAt: this.options.now(),
      });
      return {
        text: result.subscribed ? '已开启当前会话的回复通知。' : '已关闭当前会话的回复通知。',
        revision,
      };
    });
  }

  private async serializeSubscription<T>(
    credential: EnrolledFeishuCredential,
    chatId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${credential.instanceId}\u001f${credential.credentialId}\u001f${chatId}`;
    const previous = this.subscriptionTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => barrier);
    this.subscriptionTails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.subscriptionTails.get(key) === tail) this.subscriptionTails.delete(key);
    }
  }

  private renderContext(
    credential: EnrolledFeishuCredential,
    chatId: string,
    chatType: 'group' | 'p2p',
    sessionId: string,
  ): RenderContext {
    return {
      credential,
      chatId,
      chatType,
      sessionId,
      nonce: this.options.nonce,
      pendingPresentationLifetimeMs: this.options.pendingPresentationLifetimeMs,
      maxOutputBytes: this.options.limits.maxOutputBytes,
      maxPendingCards: this.options.limits.maxPendingCards,
      now: this.options.now,
    };
  }
}
