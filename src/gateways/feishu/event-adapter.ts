import {
  classifyGatewayError,
  truncateUtf8,
  type FeishuCallbackResult,
  type FeishuSessionConsoleGateway,
} from '@gateways/im';
import { mapFeishuCardActionEvent, mapFeishuMessageEvent, type FeishuEventMapperOptions } from './mapper';
import { FeishuSourceRegistry } from './source-registry';
import type { FeishuAuditBundle, FeishuSdkEventHandlers, MappedFeishuEvent } from './types';

const SAFE_REJECTION: FeishuCallbackResult = {
  acknowledged: true,
  duplicate: false,
  code: 'invalid_event',
  toast: 'Unsupported or invalid Feishu action',
};

export class FeishuSdkEventAdapter implements FeishuSdkEventHandlers {
  constructor(
    private readonly gateway: FeishuSessionConsoleGateway,
    private readonly mapper: FeishuEventMapperOptions,
    private readonly sources: FeishuSourceRegistry,
    private readonly audit: FeishuAuditBundle,
  ) {}

  async onMessage(raw: unknown): Promise<void> {
    await this.mapAndHandle(() => mapFeishuMessageEvent(raw, this.mapper));
  }

  async onCardAction(raw: unknown): Promise<unknown> {
    const result = await this.mapAndHandle(() => mapFeishuCardActionEvent(raw, this.mapper));
    return {
      toast: {
        type: ['accepted', 'deduplicated'].includes(result.code) ? 'success' : 'warning',
        content: truncateUtf8(result.toast, 256),
      },
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

  private async mapAndHandle(map: () => MappedFeishuEvent): Promise<FeishuCallbackResult> {
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
    try {
      return await this.sources.within(mapped.source, () => this.gateway.handle(mapped.event));
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
