import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { upsertEvent } from './session-store-events';

describe('compaction stream snapshots', () => {
  const event = (summary: string, sessionId = 'a', kind: AgentEvent['kind'] = 'message'): AgentEvent => ({
    sessionId, agentId: 'grok-build', kind, ts: 1,
    payload: { role: 'system', compaction: { id: 'native-a', status: 'running', summary } },
  });
  it('updates an existing stored row even with an unchanged event ID, retaining initial placement', () => {
    const first = { ...event('first'), id: 12 };
    const latest = { ...event('new'), id: 12 };
    const start = event('', 'a', 'context-compaction-start');
    const foreign = event('foreign', 'b');
    const result = upsertEvent([foreign, first, start], latest, 20);
    expect(result).toEqual([foreign, latest, start]);
    const otherProvider = { ...latest, id: 13, agentId: 'claude-code' };
    expect(upsertEvent(result, otherProvider, 20)).toHaveLength(4);
  });
});
