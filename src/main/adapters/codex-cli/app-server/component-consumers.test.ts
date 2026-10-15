import { describe, expect, it } from 'vitest';
import { CodexComponentConsumers } from './component-consumers';

describe('process-owned component consumers', () => {
  it('keeps extra-root refresh gated until every observed native child is terminal', () => {
    const consumers = new CodexComponentConsumers();
    consumers.observe({ method: 'item/started', params: { item: { type: 'collabAgentToolCall',
      receiverThreadIds: ['child'], agentsStates: {} } } }, 1);
    expect(consumers.busy(1)).toBe(true);
    consumers.observe({ method: 'thread/status/changed', params: { threadId: 'parent', status: { type: 'idle' } } }, 1);
    expect(consumers.busy(1)).toBe(true);
    consumers.observe({ method: 'item/completed', params: { item: { type: 'collabAgentToolCall',
      receiverThreadIds: ['child'], agentsStates: { child: { status: 'completed' } } } } }, 1);
    expect(consumers.busy(1)).toBe(false);
  });
  it('does not transfer native consumer state to a replacement process generation', () => {
    const consumers = new CodexComponentConsumers();
    consumers.observe({ method: 'thread/status/changed', params: { threadId: 'child', status: { type: 'active' } } }, 1);
    expect(consumers.busy(1)).toBe(true);
    expect(consumers.busy(2)).toBe(false);
    consumers.observe({ method: 'thread/status/changed', params: { threadId: 'new', status: { type: 'unknown-future-status' } } }, 2);
    expect(consumers.busy(2)).toBe(true);
  });
});
