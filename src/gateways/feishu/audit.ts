import type { Logger } from '@larksuiteoapi/node-sdk';
import type { FeishuAuditRecord, FeishuGatewayBinding, FeishuGatewayClock } from '@gateways/im';
import type {
  FeishuAuditBundle,
  FeishuAuditSink,
  FeishuOperationalAuditEntry,
} from './types';

const SAFE_CODE = /^[a-z0-9][a-z0-9_.:-]{0,95}$/;

function safeCode(value: string, fallback: string): string {
  return SAFE_CODE.test(value) ? value : fallback;
}

function boundedId(value: string | null, maximum = 256): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    ? value
    : null;
}

export function createFeishuAuditBundle(
  binding: FeishuGatewayBinding,
  clock: FeishuGatewayClock,
  sink: FeishuAuditSink,
): FeishuAuditBundle {
  const emit = (entry: FeishuOperationalAuditEntry): void => {
    try {
      sink(Object.freeze({ ...entry }));
    } catch {
      // Audit failures cannot expose payloads or break callback acknowledgement.
    }
  };
  const runtime = (
    operation: string,
    outcome: FeishuOperationalAuditEntry['outcome'],
    code: string,
    component: FeishuOperationalAuditEntry['component'] = 'runtime',
  ): void => emit({
    at: clock.now(),
    component,
    operation: safeCode(operation, 'invalid-operation'),
    outcome,
    code: safeCode(code, 'redacted-error'),
    eventId: null,
    instanceId: binding.instanceId,
    credentialId: null,
    chatId: null,
    revision: null,
  });
  const sdkLogger: Logger = {
    error: () => runtime('sdk-log', 'retryable-failure', 'sdk-error', 'sdk'),
    warn: () => runtime('sdk-log', 'retryable-failure', 'sdk-warning', 'sdk'),
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
  };
  return {
    audit: {
      record: (record: FeishuAuditRecord) => emit({
        at: record.at,
        component: 'gateway',
        operation: safeCode(record.operation, 'invalid-operation'),
        outcome: record.outcome,
        code: safeCode(record.code, 'redacted-error'),
        eventId: boundedId(record.eventId),
        instanceId: boundedId(record.instanceId),
        credentialId: boundedId(record.credentialId),
        chatId: boundedId(record.chatId),
        revision: Number.isSafeInteger(record.revision) ? record.revision : null,
      }),
    },
    observer: {
      onError: (entry) => runtime(
        safeCode(entry.operation, 'gateway-observer'),
        entry.retryable ? 'retryable-failure' : 'rejected',
        safeCode(entry.code, 'redacted-error'),
        'gateway',
      ),
      onDeliveryDropped: (entry) => emit({
        at: clock.now(),
        component: 'gateway',
        operation: 'notification-delivery',
        outcome: 'rejected',
        code: entry.reason,
        eventId: null,
        instanceId: binding.instanceId,
        credentialId: null,
        chatId: boundedId(entry.chatId),
        revision: Number.isSafeInteger(entry.revision) ? entry.revision : null,
      }),
    },
    sdkLogger,
    runtime: (operation, outcome, code) => runtime(operation, outcome, code),
  };
}
