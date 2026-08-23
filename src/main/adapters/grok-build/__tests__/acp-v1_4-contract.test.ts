import { describe, expect, it } from 'vitest';

import { createGrokTranslationState, translateGrokUpdate } from '../translate';

describe('Grok ACP 1.4 contract', () => {
  it('recognizes unadvertised compaction updates without emitting partial lifecycle events', () => {
    const state = createGrokTranslationState();

    expect(
      translateGrokUpdate(
        'app-session',
        '/repo',
        {
          sessionUpdate: 'compaction_update',
          compactionId: 'compaction-1',
          status: 'in_progress',
        },
        state,
      ),
    ).toEqual([]);
    expect(
      translateGrokUpdate(
        'app-session',
        '/repo',
        {
          sessionUpdate: 'compaction_summary_chunk',
          compactionId: 'compaction-1',
          content: { type: 'text', text: 'summary' },
        },
        state,
      ),
    ).toEqual([]);
  });
});
