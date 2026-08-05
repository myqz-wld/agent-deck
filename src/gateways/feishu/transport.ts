import { createHash } from 'node:crypto';
import {
  FeishuGatewayError,
  FEISHU_PROVIDER_UUID_DEDUP_WINDOW_MS,
  FeishuTransportNotAcceptedError,
  type FeishuDeliveryAttemptContext,
  type FeishuOutboundMessage,
  type FeishuTransportPort,
} from '@gateways/im';
import { renderFeishuCard, renderFeishuText } from './card-renderer';
import type { FeishuPresentationActionSigner } from './nonce';
import { FeishuSourceRegistry } from './source-registry';
import type { FeishuOpenApiPort, FeishuOpenApiResponse } from './types';

function providerUuid(message: FeishuOutboundMessage): string {
  const hash = createHash('sha256');
  hash.update(message.instanceId, 'utf8');
  hash.update('\u001f');
  hash.update(message.eventId, 'utf8');
  return `ad-${hash.digest('base64url')}`;
}

function assertSuccess(response: FeishuOpenApiResponse, requireMessageId: boolean): void {
  if (
    !response ||
    response.code !== 0 ||
    (requireMessageId &&
      (typeof response.data?.message_id !== 'string' || response.data.message_id.length === 0))
  ) throw new FeishuTransportNotAcceptedError();
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new FeishuTransportNotAcceptedError();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new Error('Feishu transport deadline elapsed')));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function providerCall<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await abortable(promise, signal);
  } catch (error) {
    if (error instanceof FeishuTransportNotAcceptedError || error instanceof FeishuGatewayError) {
      throw error;
    }
    throw new Error('Feishu provider transport outcome is unknown');
  }
}

export class OfficialFeishuTransport implements FeishuTransportPort {
  readonly deliverySemantics = 'event-id-idempotent' as const;
  readonly deliveryIdempotencyWindowMs = FEISHU_PROVIDER_UUID_DEDUP_WINDOW_MS;

  constructor(
    private readonly binding: { instanceId: string },
    private readonly api: FeishuOpenApiPort,
    private readonly sources: FeishuSourceRegistry,
    private readonly signer: FeishuPresentationActionSigner,
  ) {}

  async deliver(
    message: FeishuOutboundMessage,
    attempt: FeishuDeliveryAttemptContext,
  ): Promise<void> {
    if (message.instanceId !== this.binding.instanceId) {
      throw new FeishuGatewayError('access_denied', 'Outbound delivery crossed the pinned instance');
    }
    const source = this.sources.get(message.eventId);
    if (source && source.chatId !== message.chatId) {
      throw new FeishuGatewayError('event_identity_mismatch', 'Outbound chat differs from provider source');
    }
    const hasCard = message.cards.length > 0 || message.kind === 'card-update';
    const content = hasCard ? renderFeishuCard(message, this.signer) : renderFeishuText(message);
    const messageType = hasCard ? 'interactive' as const : 'text' as const;
    const uuid = providerUuid(message);

    if (message.kind === 'card-update') {
      if (!source || source.kind !== 'card-action') {
        throw new FeishuGatewayError('invalid_event', 'Card update has no active provider card source');
      }
      const response = await providerCall(
        this.api.patchCard({ messageId: source.messageId, content }),
        attempt.signal,
      );
      assertSuccess(response, false);
      return;
    }

    if (message.kind === 'reply') {
      if (!source || source.kind !== 'message') {
        throw new FeishuGatewayError('invalid_event', 'Reply has no active provider message source');
      }
      const response = await providerCall(
        this.api.reply({ messageId: source.messageId, content, messageType, uuid }),
        attempt.signal,
      );
      assertSuccess(response, true);
      return;
    }

    const response = await providerCall(
      this.api.create({ chatId: message.chatId, content, messageType, uuid }),
      attempt.signal,
    );
    assertSuccess(response, true);
  }
}
