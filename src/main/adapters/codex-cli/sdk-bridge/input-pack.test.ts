import { describe, expect, it } from 'vitest';
import {
  extractAttachmentPaths,
  packCodexAppServerInput,
  toCodexAppServerInput,
} from './input-pack';

describe('Codex app-server input attachment ownership', () => {
  it('replays source images exactly but exposes only child-owned paths for cleanup', () => {
    const packed = packCodexAppServerInput(
      [
        { type: 'localImage', path: '/uploads/source.png' },
        { type: 'text', text: 'current source request', text_elements: [] },
        { type: 'localImage', path: '/uploads/child.png' },
        { type: 'text', text: 'delegated child task', text_elements: [] },
      ],
      ['/uploads/child.png'],
    );

    expect(toCodexAppServerInput(packed)).toEqual([
      { type: 'localImage', path: '/uploads/source.png' },
      { type: 'text', text: 'current source request', text_elements: [] },
      { type: 'localImage', path: '/uploads/child.png' },
      { type: 'text', text: 'delegated child task', text_elements: [] },
    ]);
    expect(extractAttachmentPaths(packed)).toEqual(['/uploads/child.png']);
  });
});
