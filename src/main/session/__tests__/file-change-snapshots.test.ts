import { describe, expect, it } from 'vitest';
import { buildFileChangeSnapshots } from '../file-change-snapshots';

describe('buildFileChangeSnapshots', () => {
  it('captures full after content and reverses a Claude Edit snippet into full before content', () => {
    const snapshots = buildFileChangeSnapshots({
      captureAuthorized: true,
      capturedAfterSnapshot: 'alpha\nnew\nomega\n',
      kind: 'text',
      before: 'old',
      after: 'new',
      metadata: { source: 'Edit' },
    });

    expect(snapshots).toEqual({
      beforeSnapshot: 'alpha\nold\nomega\n',
      afterSnapshot: 'alpha\nnew\nomega\n',
    });
  });

  it('reverses a Codex unified diff against the full after snapshot', () => {
    const snapshots = buildFileChangeSnapshots({
      captureAuthorized: true,
      capturedAfterSnapshot: 'alpha\nnew\nomega\n',
      kind: 'text',
      before: null,
      after: null,
      metadata: {
        source: 'codex',
        changeKind: 'update',
        diff: [
          'diff --git a/codex.ts b/codex.ts',
          '--- a/codex.ts',
          '+++ b/codex.ts',
          '@@ -1,3 +1,3 @@',
          ' alpha',
          '-old',
          '+new',
          ' omega',
        ].join('\n'),
      },
    });

    expect(snapshots).toEqual({
      beforeSnapshot: 'alpha\nold\nomega\n',
      afterSnapshot: 'alpha\nnew\nomega\n',
    });
  });

  it('records Codex deletes with an empty after snapshot when the file is gone', () => {
    const snapshots = buildFileChangeSnapshots({
      captureAuthorized: true,
      capturedAfterSnapshot: null,
      kind: 'text',
      before: null,
      after: null,
      metadata: {
        source: 'codex',
        changeKind: 'delete',
        diff: [
          'diff --git a/deleted.txt b/deleted.txt',
          '--- a/deleted.txt',
          '+++ /dev/null',
          '@@ -1,2 +0,0 @@',
          '-old',
          '-gone',
        ].join('\n'),
      },
    });

    expect(snapshots).toEqual({
      beforeSnapshot: 'old\ngone',
      afterSnapshot: '',
    });
  });

  it('records Codex adds with an empty before snapshot when the diff is raw content', () => {
    const snapshots = buildFileChangeSnapshots({
      captureAuthorized: true,
      capturedAfterSnapshot: '# Created\n\ncontent\n',
      kind: 'text',
      before: null,
      after: null,
      metadata: {
        source: 'codex',
        changeKind: 'add',
        diff: '# Created\n\ncontent\n',
      },
    });

    expect(snapshots).toEqual({
      beforeSnapshot: '',
      afterSnapshot: '# Created\n\ncontent\n',
    });
  });

  it('stores no reconstructed snapshot when path identity could not be authorized', () => {
    expect(buildFileChangeSnapshots({
      captureAuthorized: false,
      capturedAfterSnapshot: null,
      kind: 'text',
      before: null,
      after: null,
      metadata: {
        source: 'codex',
        changeKind: 'delete',
        diff: '@@ -1 +0,0 @@\n-private',
      },
    })).toEqual({ beforeSnapshot: null, afterSnapshot: null });
  });
});
