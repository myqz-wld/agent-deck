import { describe, expect, it } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { readCompaction } from '@shared/compaction';
import { createGrokTranslationState, translateGrokUpdate } from '../translate';

describe('Grok ACP compaction contract', () => {
  function harness() {
    const state = createGrokTranslationState();
    return { state, translate: (update: SessionUpdate) => translateGrokUpdate('app-session', '/repo', update, state) };
  }
  it('retains a first chunk and appends in order through completion', () => {
    const { translate } = harness();
    const first = translate({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'a', content: { type: 'text', text: 'first ' } })[0];
    expect(first.kind).toBe('context-compaction-start');
    const patch = translate({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'a', content: { type: 'text', text: 'second' } })[0];
    expect(patch.kind).toBe('message');
    expect(readCompaction(patch)).toMatchObject({ summary: 'first second', status: 'running' });
    const final = translate({ sessionUpdate: 'compaction_update', compactionId: 'a', status: 'completed' })[0];
    expect(final.kind).toBe('context-compaction-end');
    expect(readCompaction(final)).toMatchObject({ id: 'grok:a', summary: 'first second', status: 'completed', revision: 3 });
    expect(readCompaction(final)?.startedAt).toBe(readCompaction(first)?.startedAt);
  });
  it('distinguishes omission, replacement, null, and empty summaries and metadata', () => {
    const { translate, state } = harness();
    translate({ sessionUpdate: 'compaction_update', compactionId: 'a', status: 'failed',
      summary: [{ type: 'text', text: 'old' }], error: 'failure', _meta: { example: true } });
    let event = translate({ sessionUpdate: 'compaction_update', compactionId: 'a', status: 'failed' })[0];
    expect(readCompaction(event)).toMatchObject({ summary: 'old', error: 'failure' });
    event = translate({ sessionUpdate: 'compaction_update', compactionId: 'a', status: 'completed',
      summary: [{ type: 'text', text: 'replacement' }], error: null })[0];
    expect(readCompaction(event)).toMatchObject({ summary: 'replacement', error: '' });
    expect(state.compactions.get('a')?.metadata).toEqual({ example: true });
    for (const summary of [null, []]) {
      event = translate({ sessionUpdate: 'compaction_update', compactionId: 'a', status: 'completed', summary, _meta: null })[0];
      expect(readCompaction(event)?.summary).toBe('');
      expect(state.compactions.get('a')?.metadata).toBeNull();
    }
  });
  it('uses the existing image pipeline and handles terminal-first and future states', () => {
    const { translate } = harness();
    const event = translate({ sessionUpdate: 'compaction_update', compactionId: 'a', status: 'cancelled',
      summary: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///workspace/note.txt', text: 'retained note' } }] })[0];
    expect(readCompaction(event)).toMatchObject({ status: 'interrupted', summary: '\nretained note\n' });
    expect(readCompaction(event)?.durationMs).toBeUndefined();
    expect(event.payload).toMatchObject({ imageInputs: [{ type: 'image', data: 'AAAA' }] });
    expect(readCompaction(translate({ sessionUpdate: 'compaction_update', compactionId: 'b', status: '_queued' })[0])?.status).toBe('unknown');
  });
});
