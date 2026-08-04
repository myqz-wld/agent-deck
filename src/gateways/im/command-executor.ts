import { FEISHU_HELP_TEXT, type FeishuCommand } from './commands';
import { assertFeishuMethod } from './client-pool';
import {
  coreIdentifier,
  coreRevision,
  validateProjectListResult,
  validateProjectResolveResult,
  validateHistoryEntries,
  validatePendingRequests,
  validateRuntimeControls,
  validateSessionConsoleCreateResult,
  validateSessionConsoleGetResult,
  validateSessionConsoleListResult,
} from './core-output';
import { FeishuGatewayError } from './errors';
import {
  renderHistory,
  renderPending,
  renderProjectList,
  renderRuntime,
  renderSessionList,
  type RenderContext,
} from './render';
import { truncateUtf8 } from './redaction';
import { assertAdapterOwnedRuntimePatch } from './runtime-policy';
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

  constructor(private readonly options: FeishuCommandExecutorOptions) {}

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
      return renderSessionList(
        result.sessions,
        result.nextCursor,
        result.total,
        this.options.limits.maxOutputBytes,
        result.revision,
      );
    }
    if (command.kind === 'projects') {
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
      return renderProjectList(
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
      assertFeishuMethod(connected.hello, 'pending.list');
      const pending = await client.request(
        'pending.list',
        { sessionId: command.sessionId },
        { deadlineMs: remaining() },
      );
      const requests = validatePendingRequests(
        pending.requests,
        command.sessionId,
        this.options.limits,
      );
      const pendingRevision = coreRevision(pending.revision);
      const view = renderPending(
        requests.filter((item) => item.status === 'pending'),
        this.renderContext(credential, event.chatId, command.sessionId),
        pendingRevision,
      );
      this.options.store.putContext({
        ...context,
        activeSessionId: command.sessionId,
        updatedAt: this.options.now(),
      });
      return {
        ...view,
        text: truncateUtf8(
          `已选择 session ${command.sessionId}\n${view.text}`,
          this.options.limits.maxOutputBytes,
        ),
      };
    }
    if (command.kind === 'create') {
      assertFeishuMethod(connected.hello, 'project.resolve');
      const rawProject = await client.request(
        'project.resolve',
        { alias: command.projectAlias },
        { deadlineMs: remaining() },
      );
      const resolved = validateProjectResolveResult(
        rawProject,
        command.projectAlias,
        this.options.limits,
      );
      if (!resolved.project) throw new FeishuGatewayError('not_found', '未知 project alias');
      assertFeishuMethod(connected.hello, 'session.console.create');
      await this.options.beforeMutation(credential, event.chatId);
      const raw = await client.request(
        'session.console.create',
        {
          adapterId: command.adapterId,
          projectRef: resolved.project.projectRef,
          options: {},
        },
        { ...mutation, deadlineMs: remaining() },
      );
      const result = validateSessionConsoleCreateResult(raw, this.options.limits);
      const sessionId = result.sessionId;
      const revision = result.revision;
      this.options.store.putContext({
        ...context,
        activeSessionId: sessionId,
        updatedAt: this.options.now(),
      });
      return { text: `已创建并选择 session ${sessionId}`, revision };
    }

    const sessionId = selectedSession(context);
    if (command.kind === 'history') {
      assertFeishuMethod(connected.hello, 'session.history');
      const result = await client.request(
        'session.history',
        {
          sessionId,
          ...(command.cursor ? { cursor: command.cursor } : {}),
          limit: this.options.limits.maxHistoryEntries,
        },
        { deadlineMs: remaining() },
      );
      const entries = validateHistoryEntries(result.entries, sessionId, this.options.limits);
      const nextCursor = result.nextCursor === null
        ? null
        : coreIdentifier(result.nextCursor, 'history.nextCursor', 512);
      return renderHistory(
        entries.slice(0, this.options.limits.maxHistoryEntries),
        nextCursor,
        this.options.limits.maxOutputBytes,
        coreRevision(result.revision),
      );
    }
    if (command.kind === 'send') {
      assertFeishuMethod(connected.hello, 'session.send');
      await this.options.beforeMutation(credential, event.chatId);
      const result = await client.request(
        'session.send',
        { sessionId, text: command.text },
        { ...mutation, deadlineMs: remaining() },
      );
      coreIdentifier(result.messageId, 'session.send.messageId');
      return {
        text: `消息已由 Core 接受（sequence ${coreRevision(result.sequence, 'session.send.sequence')}）`,
        revision: coreRevision(result.revision),
      };
    }
    if (command.kind === 'pending') {
      assertFeishuMethod(connected.hello, 'pending.list');
      const result = await client.request(
        'pending.list',
        { sessionId },
        { deadlineMs: remaining() },
      );
      const requests = validatePendingRequests(result.requests, sessionId, this.options.limits);
      return renderPending(
        requests.filter((item) => item.status === 'pending'),
        this.renderContext(credential, event.chatId, sessionId),
        coreRevision(result.revision),
      );
    }
    if (command.kind === 'runtime-get') {
      assertFeishuMethod(connected.hello, 'session.runtime.get');
      const result = await client.request(
        'session.runtime.get',
        { sessionId },
        { deadlineMs: remaining() },
      );
      return renderRuntime(
        validateRuntimeControls(result, this.options.limits),
        this.options.limits.maxOutputBytes,
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
      const result = await client.request(
        'session.runtime.update',
        { sessionId, patch: command.patch },
        {
          ...mutation,
          expectedRevision: command.expectedRevision,
          deadlineMs: remaining(),
        },
      );
      const controls = validateRuntimeControls(result.controls, this.options.limits);
      if (controls.adapterId !== validatedSession.adapterId) {
        throw new FeishuGatewayError(
          'invalid_core_response',
          'Runtime response adapter does not match the selected session',
        );
      }
      if (!['handoff-required', 'hot-applied', 'restart-required'].includes(result.effect)) {
        throw new FeishuGatewayError('invalid_core_response', 'Runtime effect is malformed');
      }
      const replacementSessionId = result.replacementSessionId === null
        ? null
        : coreIdentifier(result.replacementSessionId, 'runtime.replacementSessionId');
      const replacement = replacementSessionId
        ? `；replacement session ${replacementSessionId}`
        : '';
      return {
        text: `Runtime controls 已接受：${result.effect}${replacement}`,
        revision: controls.revision,
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
      const result = await client.request(
        'subscription.set',
        { sessionId, subscribed: command.subscribed },
        { ...mutation, deadlineMs: remaining() },
      );
      if (typeof result.subscribed !== 'boolean') {
        throw new FeishuGatewayError('invalid_core_response', 'Subscription result is malformed');
      }
      const revision = coreRevision(result.revision);
      this.options.store.putSubscription({
        instanceId: credential.instanceId,
        credentialId: credential.credentialId,
        chatId: event.chatId,
        sessionId,
        status: result.subscribed ? 'active' : 'inactive',
        updatedAt: this.options.now(),
      });
      return {
        text: result.subscribed ? '已订阅当前 session。' : '已取消订阅当前 session。',
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
    sessionId: string,
  ): RenderContext {
    return {
      credential,
      chatId,
      sessionId,
      nonce: this.options.nonce,
      pendingPresentationLifetimeMs: this.options.pendingPresentationLifetimeMs,
      maxOutputBytes: this.options.limits.maxOutputBytes,
      maxPendingCards: this.options.limits.maxPendingCards,
    };
  }
}
