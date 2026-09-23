import { describe, expect, it } from 'vitest';

import {
  createGrokTranslationState,
  flushGrokTextUpdates,
  translateGrokUpdate,
} from '../translate';

describe('Grok ACP 1.5 contract', () => {
  it('keeps streaming text intact when an unadvertised advisory notice arrives', () => {
    const state = createGrokTranslationState();
    const events = [
      ...translateGrokUpdate('app-session', '/repo', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Before ' },
      }, state),
      ...translateGrokUpdate('app-session', '/repo', {
        sessionUpdate: 'notice',
        severity: 'error',
        title: 'Optional integration unavailable',
        description: 'The agent can continue without it.',
      }, state),
      ...translateGrokUpdate('app-session', '/repo', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'after' },
      }, state),
      ...flushGrokTextUpdates('app-session', state),
    ];

    expect(events).toEqual([
      expect.objectContaining({
        kind: 'message',
        payload: { text: 'Before after', role: 'assistant' },
      }),
    ]);
    expect(state.currentAssistantText).toBe('Before after');
  });
});
