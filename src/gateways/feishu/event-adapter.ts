import {
  classifyGatewayError,
  truncateUtf8,
  type FeishuCallbackResult,
  type FeishuSessionConsoleGateway,
} from '@gateways/im';
import { mapFeishuCardActionEvent, mapFeishuMessageEvent, type FeishuEventMapperOptions } from './mapper';
import { FeishuSourceRegistry } from './source-registry';
import type {
  FeishuAuditBundle,
  FeishuPairingEventPort,
  FeishuSdkEventHandlers,
  MappedFeishuEvent,
} from './types';

const SAFE_REJECTION: FeishuCallbackResult = {
  acknowledged: true,
  duplicate: false,
  code: 'invalid_event',
  toast: '无法识别这次飞书操作，请刷新后重试。',
};

const MAX_MESSAGE_AGE_MS = 5 * 60 * 1_000;

export class FeishuSdkEventAdapter implements FeishuSdkEventHandlers {
  constructor(
    private readonly gateway: FeishuSessionConsoleGateway,
    private readonly mapper: FeishuEventMapperOptions,
    private readonly sources: FeishuSourceRegistry,
    private readonly audit: FeishuAuditBundle,
    private readonly pairing?: FeishuPairingEventPort,
  ) {}

  async onMessage(raw: unknown): Promise<void> {
    await this.mapAndHandle(() => mapFeishuMessageEvent(raw, this.mapper));
  }

  async onCardAction(raw: unknown): Promise<unknown> {
    let card: Record<string, unknown> | undefined;
    const result = await this.mapAndHandle(() => mapFeishuCardActionEvent(raw, this.mapper), value => { card = value; });
    return {
      toast: {
        type: ['accepted', 'deduplicated'].includes(result.code) ? 'success' : 'warning',
        content: truncateUtf8(result.toast, 256),
      },
      ...(card ? { card: { type: 'raw', data: card } } : {}),
    };
  }

  async handle(raw: unknown): Promise<FeishuCallbackResult> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return this.reject('invalid_event');
    let type: unknown;
    try {
      type = (raw as Record<string, unknown>).event_type;
    } catch {
      return this.reject('invalid_event');
    }
    if (type === 'im.message.receive_v1') {
      return this.mapAndHandle(() => mapFeishuMessageEvent(raw, this.mapper));
    }
    if (type === 'card.action.trigger') {
      return this.mapAndHandle(() => mapFeishuCardActionEvent(raw, this.mapper));
    }
    return this.reject('unknown_command');
  }

  private async mapAndHandle(map: () => MappedFeishuEvent,
    onCard?: (card: Record<string, unknown>) => void): Promise<FeishuCallbackResult> {
    let mapped: MappedFeishuEvent;
    try {
      mapped = map();
    } catch (error) {
      const classified = classifyGatewayError(error);
      if (classified.retryable) {
        this.audit.runtime('provider-event-map', 'retryable-failure', String(classified.code));
        throw new Error('Retryable Feishu event processing failure');
      }
      return this.reject(String(classified.code));
    }
    if (mapped.event.kind === 'message' && this.mapper.now() - mapped.event.occurredAt > MAX_MESSAGE_AGE_MS) {
      // Resolve the SDK callback to stop retries; do not pair, call Core, or send a reply.
      this.audit.runtime('provider-event', 'accepted', 'event_expired');
      return { acknowledged: true, duplicate: false, code: 'event_expired', toast: '' };
    }
    try {
      return await this.sources.within(mapped.source, async () => {
        if (mapped.event.kind === 'message') {
          const paired = await this.pairing?.handle(mapped.event);
          if (paired) return paired;
        }
        const result = await this.gateway.handle(mapped.event);
        const card = this.sources.getCallbackCard(mapped.event.eventId);
        if (card && ['accepted', 'deduplicated', 'already_decided'].includes(result.code)) onCard?.(card);
        return result;
      });
    } catch (error) {
      const classified = classifyGatewayError(error);
      if (classified.retryable) {
        this.audit.runtime('provider-event-handle', 'retryable-failure', String(classified.code));
        throw new Error('Retryable Feishu event processing failure');
      }
      return this.reject(String(classified.code));
    }
  }

  private reject(code: string): FeishuCallbackResult {
    this.audit.runtime('provider-event', 'rejected', code);
    return { ...SAFE_REJECTION, code };
  }
}
