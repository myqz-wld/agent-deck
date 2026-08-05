import { FeishuGatewayError } from '@gateways/im';
import type { FeishuProviderSource } from './types';

interface SourceEntry {
  source: FeishuProviderSource;
  references: number;
}

const DEFAULT_MAXIMUM_ACTIVE_EVENTS = 256;
const MAXIMUM_CONFIGURABLE_ACTIVE_EVENTS = 10_000;

function sameSource(left: FeishuProviderSource, right: FeishuProviderSource): boolean {
  return (
    left.eventId === right.eventId &&
    left.chatId === right.chatId &&
    left.messageId === right.messageId &&
    left.kind === right.kind &&
    left.occurredAt === right.occurredAt
  );
}

/** In-memory only: provider message ids are never written to the metadata database. */
export class FeishuSourceRegistry {
  private readonly entries = new Map<string, SourceEntry>();

  constructor(
    private readonly maximumActiveEvents = DEFAULT_MAXIMUM_ACTIVE_EVENTS,
  ) {
    if (
      !Number.isSafeInteger(maximumActiveEvents) ||
      maximumActiveEvents <= 0 ||
      maximumActiveEvents > MAXIMUM_CONFIGURABLE_ACTIVE_EVENTS
    ) {
      throw new FeishuGatewayError(
        'invalid_configuration',
        'Feishu active event ceiling is invalid',
      );
    }
  }

  async within<T>(source: FeishuProviderSource, work: () => Promise<T>): Promise<T> {
    const current = this.entries.get(source.eventId);
    if (current && !sameSource(current.source, source)) {
      throw new FeishuGatewayError(
        'event_identity_mismatch',
        'Feishu event id was replayed with a different provider source',
      );
    }
    if (current) {
      if (current.references >= Number.MAX_SAFE_INTEGER) {
        throw new FeishuGatewayError('event_in_progress', 'Feishu event reference limit reached', true);
      }
      current.references += 1;
    } else {
      if (this.entries.size >= this.maximumActiveEvents) {
        throw new FeishuGatewayError('event_in_progress', 'Feishu active event ceiling reached', true);
      }
      this.entries.set(source.eventId, { source: { ...source }, references: 1 });
    }
    try {
      return await work();
    } finally {
      const entry = this.entries.get(source.eventId);
      if (entry) {
        entry.references -= 1;
        if (entry.references === 0) this.entries.delete(source.eventId);
      }
    }
  }

  get(eventId: string): FeishuProviderSource | null {
    const entry = this.entries.get(eventId);
    return entry ? { ...entry.source } : null;
  }

  size(): number {
    return this.entries.size;
  }
}
