import { describe, expect, it } from 'vitest';
import {
  isEffectiveCodexFileChange,
  isIncompleteCodexFileChangeStatus,
} from '../codex-file-change';

describe('codex-file-change helpers', () => {
  it('treats explicit non-completed patch status as incomplete', () => {
    expect(isIncompleteCodexFileChangeStatus('failed')).toBe(true);
    expect(isIncompleteCodexFileChangeStatus('inProgress')).toBe(true);
    expect(isIncompleteCodexFileChangeStatus('completed')).toBe(false);
    expect(isIncompleteCodexFileChangeStatus(undefined)).toBe(false);
  });

  it('filters update-like changes without effective text changes', () => {
    expect(isEffectiveCodexFileChange('update', '')).toBe(false);
    expect(
      isEffectiveCodexFileChange(
        'update',
        [
          'diff --git a/a.ts b/a.ts',
          'index 1111111..1111111 100644',
          '--- a/a.ts',
          '+++ b/a.ts',
        ].join('\n'),
      ),
    ).toBe(false);
    expect(
      isEffectiveCodexFileChange(
        'update',
        ['@@ -1 +1 @@', '-same', '+same'].join('\n'),
      ),
    ).toBe(false);
  });

  it('keeps real text changes and non-text diff signals', () => {
    expect(
      isEffectiveCodexFileChange(
        'update',
        ['@@ -1 +1 @@', '-old', '+new'].join('\n'),
      ),
    ).toBe(true);
    expect(
      isEffectiveCodexFileChange(
        'update',
        ['diff --git a/image.png b/image.png', 'Binary files a/image.png and b/image.png differ'].join(
          '\n',
        ),
      ),
    ).toBe(true);
    expect(
      isEffectiveCodexFileChange(
        'move',
        ['diff --git a/old.ts b/new.ts', 'similarity index 100%', 'rename from old.ts', 'rename to new.ts'].join(
          '\n',
        ),
      ),
    ).toBe(true);
  });
});
