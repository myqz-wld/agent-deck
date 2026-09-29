import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import { dedupeRecentEvents, upsertEvent } from './session-store-events';
const plan = (planId: string, ts: number): AgentEvent => ({
  sessionId: 's', agentId: 'codex-cli', kind: 'thinking', ts,
  payload: { plan: true, planId, text: `progress ${ts}` },
});
describe('plan update projection', () => {
  it('updates one plan without replacing ordinary reasoning or another turn', () => {
    const original = [plan('second', 2), plan('first', 1)];
    const update = plan('second', 3);
    const result = upsertEvent(original, update, 200);
    expect(result).toEqual([update, original[1]]);
    expect(dedupeRecentEvents([update, ...original], 200)).toEqual(result);
  });
});
