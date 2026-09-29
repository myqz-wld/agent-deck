import { describe, expect, it } from 'vitest';
import type { DiffPayload, FileChangePayload } from '../types';
import { fileChangeToDiff, normalizeTextDiff } from '../file-change-diff';

const base: DiffPayload = { kind: 'text', filePath: 'src/demo.ts', before: null, after: null, ts: 1 };

describe('provider-independent file diff data', () => {
  it.each([
    { source: 'Write', before: null, after: 'first\nsecond\n' },
    { source: 'grok-acp', before: null, after: 'first\nsecond\n' },
    { source: 'codex', changeKind: 'add', diff: 'first\nsecond\n' },
  ])('normalizes $source additions into the same full-file view', ({ before, after, ...metadata }) => {
    const result = normalizeTextDiff({ ...base, before: before ?? null, after: after ?? null, metadata });
    expect(result).toMatchObject({ change: 'added', after: 'first\nsecond\n', patch: null });
  });

  it('shows Codex raw deletion and empty addition content without patch parsing', () => {
    expect(normalizeTextDiff({ ...base, metadata: { source: 'codex', changeKind: 'delete', diff: 'old\n' } }))
      .toEqual({ change: 'deleted', before: 'old\n', after: '', patch: null });
    expect(normalizeTextDiff({ ...base, metadata: { source: 'codex', changeKind: 'add', diff: '' } }))
      .toEqual({ change: 'added', before: '', after: '', patch: null });
  });
  it('preserves raw Codex files that contain patch examples in their body', () => {
    const content = '# Example\n\n@@ -1 +1 @@\n-old\n+new\n';
    expect(normalizeTextDiff({ ...base, metadata: { source: 'codex', changeKind: 'add', diff: content } }))
      .toMatchObject({ change: 'added', after: content });
  });

  it.each([
    { source: 'codex', changeKind: 'update', diff: '@@ -4,0 +5,1 @@\n+inserted' },
    { source: 'Edit' },
  ])('keeps insertions into existing files as modifications ($source)', (metadata) => {
    const payload = metadata.source === 'Edit' ? { before: '', after: 'inserted' } : {};
    expect(normalizeTextDiff({ ...base, ...payload, metadata }).change).toBe('modified');
  });

  it('does not join a recorded snippet to an unrelated full snapshot', () => {
    const change: FileChangePayload = {
      id: 1, sessionId: 'session', kind: 'text', filePath: 'demo.ts',
      beforeBlob: 'old', afterBlob: 'new', beforeSnapshot: null,
      afterSnapshot: 'context\nnew\ncontext', metadata: { source: 'Edit' }, toolCallId: null, ts: 1,
    };
    expect(fileChangeToDiff(change)).toMatchObject({ before: 'old', after: 'new' });
    expect(fileChangeToDiff({ ...change, beforeSnapshot: 'context\nold\ncontext' }))
      .toMatchObject({ before: 'context\nold\ncontext', after: 'context\nnew\ncontext' });
  });

  it('falls back to a recorded patch if snapshot reconstruction failed on one side', () => {
    const diff = '@@ -3,1 +3,1 @@\n-old\n+new';
    const payload = fileChangeToDiff({ id: 2, sessionId: 'session', filePath: 'demo.ts', kind: 'text',
      beforeBlob: null, afterBlob: null, beforeSnapshot: null, afterSnapshot: 'future content',
      metadata: { source: 'codex', changeKind: 'update', diff }, toolCallId: null, ts: 2 });
    expect(normalizeTextDiff(payload)).toMatchObject({ change: 'modified', before: 'old', after: 'new' });
  });
});
