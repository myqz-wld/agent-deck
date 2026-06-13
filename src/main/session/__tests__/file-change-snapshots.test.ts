import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFileChangeSnapshots } from '../file-change-snapshots';

let tempRoot: string | null = null;

function tempFile(name: string, content: string): string {
  tempRoot ??= mkdtempSync(join(tmpdir(), 'agent-deck-file-snapshots-'));
  const file = join(tempRoot, name);
  writeFileSync(file, content, 'utf8');
  return file;
}

afterEach(() => {
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  tempRoot = null;
});

describe('buildFileChangeSnapshots', () => {
  it('captures full after content and reverses a Claude Edit snippet into full before content', () => {
    const filePath = tempFile('edit.txt', 'alpha\nnew\nomega\n');

    const snapshots = buildFileChangeSnapshots({
      filePath,
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
    const filePath = tempFile('codex.ts', 'alpha\nnew\nomega\n');

    const snapshots = buildFileChangeSnapshots({
      filePath,
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
    tempRoot = mkdtempSync(join(tmpdir(), 'agent-deck-file-snapshots-'));
    const filePath = join(tempRoot, 'deleted.txt');

    const snapshots = buildFileChangeSnapshots({
      filePath,
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
});
