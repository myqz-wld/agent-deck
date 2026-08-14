import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { assertFeishuMethod } from './client-pool';
import {
  validateSessionConsoleGetResult,
  validateSessionDeleteResult,
} from './core-output';
import { FeishuGatewayError } from './errors';
import type {
  ConnectedFeishuClient,
  EnrolledFeishuCredential,
  FeishuChatContext,
  FeishuGatewayLimits,
  FeishuGatewayStore,
  FeishuMessageEvent,
  SessionConsoleView,
} from './types';

const CONFIRMATION_LIFETIME_MS = 5 * 60 * 1_000;
const CLAIM_LIFETIME_MS = 60_000;
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1_000;

function tokenHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function selectedSession(context: FeishuChatContext): string {
  if (!context.activeSessionId) {
    throw new FeishuGatewayError('session_not_selected', '请先使用 /select 选择 session');
  }
  return context.activeSessionId;
}

function p2p(event: FeishuMessageEvent): void {
  if (event.chatType !== 'p2p') {
    throw new FeishuGatewayError('access_denied', 'Session 删除只能在单聊中确认');
  }
}

export interface FeishuSessionDeleteControllerOptions {
  store: FeishuGatewayStore;
  limits: FeishuGatewayLimits;
  now(): number;
  beforeMutation(credential: EnrolledFeishuCredential, chatId: string): Promise<void>;
}

export class FeishuSessionDeleteController {
  constructor(private readonly options: FeishuSessionDeleteControllerOptions) {}

  async prepare(
    event: FeishuMessageEvent,
    credential: EnrolledFeishuCredential,
    context: FeishuChatContext,
    connected: ConnectedFeishuClient,
    remaining: () => number,
  ): Promise<SessionConsoleView> {
    p2p(event);
    const sessionId = selectedSession(context);
    await this.options.beforeMutation(credential, event.chatId);
    assertFeishuMethod(connected.hello, 'session.console.get');
    const raw = await connected.client.request(
      'session.console.get',
      { sessionId },
      { deadlineMs: remaining() },
    );
    const result = validateSessionConsoleGetResult(raw, sessionId, this.options.limits);
    if (!result.session) throw new FeishuGatewayError('not_found', 'Session 不存在');
    const now = this.options.now();
    this.options.store.pruneDeleteConfirmations(
      Math.max(0, now - TERMINAL_RETENTION_MS),
      now,
    );
    const token = randomBytes(24).toString('base64url');
    this.options.store.createDeleteConfirmation({
      instanceId: credential.instanceId,
      confirmationId: randomUUID(),
      tokenHash: tokenHash(token),
      credentialId: credential.credentialId,
      chatId: event.chatId,
      openId: event.openId,
      sessionId,
      expectedArchived: result.session.archived,
      expectedUpdatedAt: result.session.updatedAt,
      status: 'pending',
      claimEventId: null,
      claimExpiresAt: null,
      expiresAt: now + CONFIRMATION_LIFETIME_MS,
      createdAt: now,
      updatedAt: now,
    });
    return {
      text: [
        `即将永久删除 session ${sessionId}。`,
        `标题：${result.session.title ?? '（未命名）'}。`,
        `当前状态：archived=${result.session.archived ? '是' : '否'}，updatedAt=${result.session.updatedAt}。`,
        `请在 5 分钟内发送 /delete-confirm ${token} 完成删除。`,
      ].join('\n'),
      revision: result.revision,
    };
  }

  async confirm(
    confirmationToken: string,
    event: FeishuMessageEvent,
    credential: EnrolledFeishuCredential,
    connected: ConnectedFeishuClient,
    remaining: () => number,
  ): Promise<SessionConsoleView> {
    p2p(event);
    const now = this.options.now();
    const claim = this.options.store.claimDeleteConfirmation({
      instanceId: credential.instanceId,
      credentialId: credential.credentialId,
      chatId: event.chatId,
      openId: event.openId,
      tokenHash: tokenHash(confirmationToken),
      eventId: event.eventId,
      now,
      claimLifetimeMs: CLAIM_LIFETIME_MS,
    });
    if (claim.state === 'invalid') {
      throw new FeishuGatewayError('invalid_confirmation', '删除确认无效');
    }
    if (claim.state === 'expired') {
      throw new FeishuGatewayError('invalid_confirmation', '删除确认已过期，请重新发送 /delete');
    }
    if (claim.state === 'in-progress') {
      throw new FeishuGatewayError('event_in_progress', '另一个删除确认正在执行', true);
    }
    if (claim.state === 'completed') {
      return { text: `Session ${claim.record?.sessionId ?? ''} 已删除。`, revision: null };
    }
    const confirmation = claim.record;
    if (!confirmation) {
      throw new FeishuGatewayError('invalid_confirmation', '删除确认无效');
    }
    try {
      assertFeishuMethod(connected.hello, 'session.delete');
      await this.options.beforeMutation(credential, event.chatId);
      const raw = await connected.client.request(
        'session.delete',
        {
          sessionId: confirmation.sessionId,
          expectedArchived: confirmation.expectedArchived,
          expectedUpdatedAt: confirmation.expectedUpdatedAt,
        },
        {
          idempotencyKey: `feishu:delete:${confirmation.confirmationId}`,
          deadlineMs: remaining(),
        },
      );
      const result = validateSessionDeleteResult(
        raw,
        confirmation.sessionId,
        this.options.limits,
      );
      if (!this.options.store.completeDeleteConfirmation(
        confirmation.instanceId,
        confirmation.confirmationId,
        event.eventId,
        this.options.now(),
      )) {
        throw new FeishuGatewayError(
          'delivery_generation_lost',
          'Delete confirmation generation was lost',
          true,
        );
      }
      return { text: `已删除 session ${confirmation.sessionId}。`, revision: result.revision };
    } catch (error) {
      this.options.store.releaseDeleteConfirmation(
        confirmation.instanceId,
        confirmation.confirmationId,
        event.eventId,
        this.options.now(),
      );
      throw error;
    }
  }
}
