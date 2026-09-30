import type { SessionRecord } from '@shared/types';
import type { FeishuAssistantStore } from './feishu-assistant-store';

export class FeishuAssistantAuthority {
  constructor(private readonly assistants: Pick<FeishuAssistantStore, 'read'>,
    private readonly sessions: { get(id: string): SessionRecord | null },
    private readonly successor: (id: string) => string | null) {}

  private identities(): Set<string> {
    const ids = new Set(this.assistants.read());
    for (const id of ids) {
      if (ids.size > 16_384) throw new Error('Assistant ownership directory exceeds its bound');
      const next = this.successor(id);
      if (next) ids.add(next);
    }
    return ids;
  }

  caller(id: string): SessionRecord {
    const session = this.sessions.get(id);
    if (!session || session.source !== 'sdk' || session.lifecycle === 'closed' || session.archivedAt !== null ||
      session.hiddenFromHistory || this.successor(id) !== null || !this.identities().has(id)) {
      throw new Error('Live registered Feishu assistant is required; use the current handoff owner');
    }
    return session;
  }

  work(callerId: string, targetId: string): SessionRecord {
    this.caller(callerId);
    const session = this.sessions.get(targetId);
    if (!session || session.hiddenFromHistory || session.lifecycle === 'closed' || session.archivedAt !== null ||
      this.identities().has(targetId)) throw new Error('Choose an open work session from list_work_sessions');
    return session;
  }
}
