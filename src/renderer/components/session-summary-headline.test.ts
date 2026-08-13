import { describe, expect, it } from 'vitest';

import { sessionSummaryHeadline } from './session-summary-headline';

describe('sessionSummaryHeadline', () => {
  it('uses the same first-line and fallback-source presentation for Local and Remote cards', () => {
    expect(sessionSummaryHeadline(
      'First line\nSecond line',
      'assistant-fallback',
      'Fallback',
    )).toEqual({ line: '降级 · First line', title: 'First line\nSecond line' });
    expect(sessionSummaryHeadline(null, null, 'Fallback'))
      .toEqual({ line: 'Fallback', title: 'Fallback' });
  });
});
