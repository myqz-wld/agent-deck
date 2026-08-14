import { createHash, randomUUID } from 'node:crypto';
import {
  FeishuCallbackAttempt,
  FeishuGatewayError,
  boundFeishuOutboundMessage,
  type FeishuCallbackResult,
  type FeishuGatewayBinding,
  type FeishuGatewayClock,
  type FeishuMessageEvent,
  type FeishuOutboundMessage,
  type FeishuTransportPort,
} from '@gateways/im';
import type {
  FeishuAuditBundle,
  FeishuPairingEventPort,
  FeishuPairingStore,
} from './types';

const PAIRING_COMMAND = /^\/pair ([A-Za-z0-9_-]{32})$/u;
const PAIRING_RETENTION_MS = 24 * 60 * 60 * 1_000;

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export class FeishuPairingEventHandler implements FeishuPairingEventPort {
  constructor(
    private readonly store: FeishuPairingStore,
    private readonly transport: FeishuTransportPort,
    private readonly binding: FeishuGatewayBinding,
    private readonly clock: FeishuGatewayClock,
    private readonly audit: FeishuAuditBundle,
    private readonly callbackWindowMs: number,
  ) {}

  async handle(event: FeishuMessageEvent): Promise<FeishuCallbackResult | null> {
    if (!event.text.trimStart().startsWith('/pair')) return null;
    const match = event.text.trim().match(PAIRING_COMMAND);
    if (event.chatType !== 'p2p' || !match) {
      return this.reply(
        event,
        '配对只能在单聊中使用，格式为 /pair <pairing-code>。',
        'invalid_command',
      );
    }
    const now = this.clock.now();
    this.store.prunePairingMetadata(Math.max(0, now - PAIRING_RETENTION_MS), now);
    const result = this.store.consumePairingCode({
      instanceId: this.binding.instanceId,
      appId: event.appId,
      tenantKey: event.tenantKey,
      openId: event.openId,
      chatId: event.chatId,
      displayName: event.displayName ?? null,
      eventId: event.eventId,
      codeHash: hash(match[1]),
      requestId: randomUUID(),
      now,
    });
    if (result.state === 'accepted' || result.state === 'duplicate') {
      const requestId = result.request?.requestId;
      if (!requestId) {
        throw new FeishuGatewayError('invalid_configuration', 'Pairing request was not persisted');
      }
      this.audit.runtime('pair-request', 'accepted', result.state);
      return this.reply(
        event,
        `配对请求已提交。请在 Agent Deck 服务器上批准请求 ${requestId}。`,
        'pairing_pending',
      );
    }
    if (result.state === 'already-paired') {
      this.audit.runtime('pair-request', 'rejected', 'already-paired');
      return this.reply(event, '该 Agent Deck 飞书连接已完成配对。', 'already_paired');
    }
    this.audit.runtime('pair-request', 'rejected', result.state);
    return this.reply(event, '配对码无效或已过期。请在服务器上重新生成。', 'invalid_confirmation');
  }

  private async reply(
    event: FeishuMessageEvent,
    text: string,
    code: string,
  ): Promise<FeishuCallbackResult> {
    const attempt = new FeishuCallbackAttempt(1, this.callbackWindowMs, this.clock);
    const timer = this.clock.setTimer(() => attempt.expire(), this.callbackWindowMs);
    const message: FeishuOutboundMessage = boundFeishuOutboundMessage({
      eventId: event.eventId,
      instanceId: this.binding.instanceId,
      credentialId: 'pairing',
      chatId: event.chatId,
      kind: 'reply',
      text,
      cards: [],
    }, 4_096);
    try {
      attempt.remainingMs();
      await this.transport.deliver(message, attempt.transportContext(1));
      attempt.remainingMs();
      return { acknowledged: true, duplicate: false, code, toast: text };
    } catch (error) {
      throw new FeishuGatewayError(
        'delivery_failed',
        'Feishu pairing response delivery failed',
        true,
        undefined,
        { cause: error },
      );
    } finally {
      timer.cancel();
    }
  }
}
