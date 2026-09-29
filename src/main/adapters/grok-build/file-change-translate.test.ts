import { describe, expect, it } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { createGrokTranslationState, translateGrokUpdate, beginGrokTurn } from './translate';

const diff = { type: 'diff' as const, path: 'src/demo.ts', oldText: 'old', newText: 'new' };
function setup() {
  const state = createGrokTranslationState();
  return { state, update: (update: SessionUpdate) => translateGrokUpdate('session', '/repo', update, state) };
}
describe('Grok completed file changes', () => {
  it('captures diffs on initially completed calls and suppresses duplicate completion updates', () => {
    const { update } = setup();
    const events = update({ sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Edit', status: 'completed', content: [diff] });
    expect(events.map((event) => event.kind)).toEqual(['tool-use-start', 'tool-use-end', 'file-changed']);
    expect(events[2]?.payload).toMatchObject({ before: 'old', after: 'new', toolCallId: 'tool' });
    expect(update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed', content: [diff] })
      .filter((event) => event.kind === 'file-changed')).toHaveLength(0);
  });
  it.each(['completed', 'failed'] as const)('holds progress diffs until the %s result', (status) => {
    const { update } = setup();
    update({ sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Edit', status: 'pending', content: [diff] });
    expect(update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'in_progress', content: [{ ...diff, oldText: 'new', newText: 'latest' }] })
      .filter((event) => event.kind === 'file-changed')).toHaveLength(0);
    const changes = update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status })
      .filter((event) => event.kind === 'file-changed');
    expect(changes).toHaveLength(status === 'completed' ? 1 : 0);
    if (status === 'completed') expect(changes[0]?.payload).toMatchObject({ before: 'old', after: 'latest' });
  });
  it('keeps late content-only diffs after success, while rejecting them after failure', () => {
    const { update } = setup();
    for (const status of ['completed', 'failed'] as const) {
      update({ sessionUpdate: 'tool_call', toolCallId: status, title: 'Edit', status });
      const events = update({ sessionUpdate: 'tool_call_update', toolCallId: status, content: [diff] });
      expect(events.filter((event) => event.kind === 'file-changed')).toHaveLength(status === 'completed' ? 1 : 0);
    }
  });
  it('drops unfinished previous-turn diffs and keeps multiple changed files', () => {
    const { update, state } = setup();
    update({ sessionUpdate: 'tool_call', toolCallId: 'old', title: 'Edit', status: 'pending', content: [diff] });
    beginGrokTurn(state, 'session', null);
    expect(state.fileChanges.pending.size).toBe(0);
    const changes = update({ sessionUpdate: 'tool_call', toolCallId: 'new', title: 'Edit', status: 'completed',
      content: [diff, { ...diff, path: 'src/new.ts', oldText: null }] }).filter((event) => event.kind === 'file-changed');
    expect(changes).toHaveLength(2);
    expect(changes[1]?.payload).toMatchObject({ metadata: { changeKind: 'add' } });
  });
});
