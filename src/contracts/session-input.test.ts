import { describe, expect, it } from 'vitest';

import { parseSessionInputCapabilitiesResult } from './session-input';

describe('session active input contract', () => {
  it('parses one negotiated image-capable active-turn surface', () => {
    const value = {
      adapterId: 'grok-build',
      activeTurn: {
        mode: 'interject',
        attachments: {
          enabled: true,
          disabledReason: null,
          maxCount: 4,
          maxBytesEach: 2_097_152,
          maxBytesTotal: 2_097_152,
          mimeTypes: ['image/png'],
        },
      },
      commands: [{
        name: 'compact',
        description: '压缩上下文',
        argumentHint: '',
        aliases: [],
      }],
      revision: 9,
    };
    expect(parseSessionInputCapabilitiesResult(value)).toEqual(value);
  });

  it('rejects unknown active modes and incomplete policies', () => {
    expect(() => parseSessionInputCapabilitiesResult({
      adapterId: 'grok-build', activeTurn: { mode: 'stream', attachments: {} },
      commands: [], revision: 1,
    })).toThrow('active turn');
  });
});
