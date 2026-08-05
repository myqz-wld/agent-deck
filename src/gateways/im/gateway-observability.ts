import type {
  EnrolledFeishuCredential,
  FeishuAuditPort,
  FeishuAuditRecord,
  FeishuGatewayObserver,
  FeishuInboundEvent,
  NotificationEvent,
} from './types';

export class FeishuGatewayObservability {
  constructor(
    private readonly auditPort: FeishuAuditPort | undefined,
    private readonly observer: FeishuGatewayObserver | undefined,
    private readonly now: () => number,
  ) {}

  result(
    event: FeishuInboundEvent,
    credential: EnrolledFeishuCredential,
    operation: string,
    outcome: FeishuAuditRecord['outcome'],
    code: string,
    revision: number | null,
  ): void {
    this.audit({
      at: this.now(),
      eventId: event.eventId,
      instanceId: credential.instanceId,
      credentialId: credential.credentialId,
      chatId: event.chatId,
      operation,
      outcome,
      code,
      revision,
    });
  }

  audit(record: FeishuAuditRecord): void {
    try {
      this.auditPort?.record(record);
    } catch {
      this.error('audit_exception', 'audit', false);
    }
  }

  error(code: string, operation: string, retryable: boolean): void {
    try {
      this.observer?.onError({ code, operation, retryable });
    } catch {
      // Observer failures never affect provider execution or another chat.
    }
  }

  notificationExhausted(
    credential: EnrolledFeishuCredential,
    chatId: string,
    eventId: string,
    event: NotificationEvent,
  ): void {
    this.audit({
      at: this.now(),
      eventId,
      instanceId: credential.instanceId,
      credentialId: credential.credentialId,
      chatId,
      operation: 'core-notification-skip',
      outcome: 'rejected',
      code: 'delivery_exhausted',
      revision: event.revision,
    });
    try {
      this.observer?.onDeliveryDropped({
        chatId,
        revision: event.revision,
        reason: 'delivery-exhausted',
      });
    } catch {
      // Observer failures never poison a consumed terminal notification.
    }
  }
}
