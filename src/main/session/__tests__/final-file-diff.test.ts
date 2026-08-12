import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionRepoMock = vi.hoisted(() => ({ get: vi.fn() }));
const fileChangeRepoMock = vi.hoisted(() => ({
  listForSession: vi.fn(),
  readPathBoundaries: vi.fn(),
  listPathPatchPage: vi.fn(),
}));

vi.mock('@main/store/session-repo', () => ({ sessionRepo: sessionRepoMock }));
vi.mock('@main/store/file-change-read-repo', () => ({
  fileChangeReadRepo: fileChangeRepoMock,
}));

import { getSessionFileFinalDiff } from '../final-file-diff';

describe('getSessionFileFinalDiff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionRepoMock.get.mockReturnValue({ id: 's1', cwd: '/repo' });
    fileChangeRepoMock.listForSession.mockReturnValue([
      { id: 1, filePath: '/repo/src/a.ts', ts: 1, metadata: {} },
    ]);
    fileChangeRepoMock.readPathBoundaries.mockImplementation(
      (_sessionId: string, candidates: string[]) => {
        const rows = fileChangeRepoMock
          .listForSession()
          .filter((change: { filePath: string }) => candidates.includes(change.filePath))
          .sort(
            (a: { ts: number; id: number }, b: { ts: number; id: number }) =>
              a.ts - b.ts || a.id - b.id,
          );
        return rows.length === 0 ? null : { first: rows[0], last: rows.at(-1) };
      },
    );
    fileChangeRepoMock.listPathPatchPage.mockImplementation(
      (_sessionId: string, candidates: string[]) => ({
        items: fileChangeRepoMock
          .listForSession()
          .filter((change: { filePath: string }) => candidates.includes(change.filePath))
          .map((change: { id: number; ts: number; metadata: { diff?: unknown } }) => ({
            id: change.id,
            ts: change.ts,
            diff: typeof change.metadata?.diff === 'string' ? change.metadata.diff : null,
          }))
          .sort(
            (a: { ts: number; id: number }, b: { ts: number; id: number }) =>
              b.ts - a.ts || b.id - a.id,
          ),
        nextCursor: null,
      }),
    );
  });

  it('rejects paths that are not recorded in file_changes for the session', async () => {
    const result = await getSessionFileFinalDiff('s1', '/repo/other.ts');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_in_session');
  });

  it('returns final diff from the first before snapshot to the last after snapshot', async () => {
    fileChangeRepoMock.listForSession.mockReturnValue([
      {
        id: 2,
        sessionId: 's1',
        filePath: '/repo/src/a.ts',
        kind: 'text',
        beforeBlob: 'mid',
        afterBlob: 'new',
        beforeSnapshot: 'mid\n',
        afterSnapshot: 'new\n',
        metadata: { source: 'Edit' },
        toolCallId: 'tool-2',
        ts: 2,
      },
      {
        id: 1,
        sessionId: 's1',
        filePath: '/repo/src/a.ts',
        kind: 'text',
        beforeBlob: 'old',
        afterBlob: 'mid',
        beforeSnapshot: 'old\n',
        afterSnapshot: 'mid\n',
        metadata: { source: 'Edit' },
        toolCallId: 'tool-1',
        ts: 1,
      },
    ]);

    const result = await getSessionFileFinalDiff('s1', '/repo/src/a.ts');

    expect(result.ok).toBe(true);
    expect(result.source).toBe('recorded-snapshot');
    expect(result.diff).toContain('-old');
    expect(result.diff).toContain('+new');
    expect(result.diff).not.toContain('mid');
  });

  it('preserves initial file creation as a whole-file final addition', async () => {
    fileChangeRepoMock.listForSession.mockReturnValue([
      {
        id: 1,
        sessionId: 's1',
        filePath: 'src/a.ts',
        kind: 'text',
        beforeBlob: null,
        afterBlob: 'initial\n',
        beforeSnapshot: '',
        afterSnapshot: 'initial\n',
        metadata: {
          source: 'codex',
          changeKind: 'update',
          diff: [
            'diff --git a/src/a.ts b/src/a.ts',
            'new file mode 100644',
            '--- /dev/null',
            '+++ b/src/a.ts',
            '@@ -0,0 +1 @@',
            '+initial',
          ].join('\n'),
        },
        toolCallId: 'tool-1',
        ts: 1,
      },
      {
        id: 2,
        sessionId: 's1',
        filePath: '/repo/src/a.ts',
        kind: 'text',
        beforeBlob: 'initial',
        afterBlob: 'final',
        beforeSnapshot: 'initial\n',
        afterSnapshot: 'final\n',
        metadata: { source: 'Edit' },
        toolCallId: 'tool-2',
        ts: 2,
      },
    ]);

    const result = await getSessionFileFinalDiff('s1', '/repo/src/a.ts');

    expect(result.ok).toBe(true);
    expect(result.diff).toContain('new file mode 100644');
    expect(result.diff).toContain('--- /dev/null');
    expect(result.diff).toContain('+++ b//repo/src/a.ts');
    expect(result.diff).toContain('@@ -0,0 +1,1 @@');
    expect(result.diff).toContain('+final');
    expect(result.diff).not.toContain('-initial');
  });

  it('treats historical add records with null before snapshots as final additions', async () => {
    fileChangeRepoMock.listForSession.mockReturnValue([
      {
        id: 1,
        sessionId: 's1',
        filePath: '/repo/src/a.ts',
        kind: 'text',
        beforeBlob: null,
        afterBlob: null,
        beforeSnapshot: null,
        afterSnapshot: 'initial\n',
        metadata: {
          source: 'codex',
          changeKind: 'add',
          diff: 'initial\n',
        },
        toolCallId: 'tool-1',
        ts: 1,
      },
      {
        id: 2,
        sessionId: 's1',
        filePath: '/repo/src/a.ts',
        kind: 'text',
        beforeBlob: null,
        afterBlob: null,
        beforeSnapshot: 'initial\n',
        afterSnapshot: 'final\n',
        metadata: {
          source: 'codex',
          changeKind: 'update',
          diff: '@@ -1 +1 @@\n-initial\n+final',
        },
        toolCallId: 'tool-2',
        ts: 2,
      },
    ]);

    const result = await getSessionFileFinalDiff('s1', '/repo/src/a.ts');

    expect(result.ok).toBe(true);
    expect(result.source).toBe('recorded-snapshot');
    expect(result.diff).toContain('new file mode 100644');
    expect(result.diff).toContain('--- /dev/null');
    expect(result.diff).toContain('@@ -0,0 +1,1 @@');
    expect(result.diff).toContain('+final');
    expect(result.diff).not.toContain('-initial');
  });

  it('preserves final file deletion as a whole-file final deletion', async () => {
    fileChangeRepoMock.listForSession.mockReturnValue([
      {
        id: 1,
        sessionId: 's1',
        filePath: '/repo/src/a.ts',
        kind: 'text',
        beforeBlob: 'old',
        afterBlob: 'mid',
        beforeSnapshot: 'old\n',
        afterSnapshot: 'mid\n',
        metadata: { source: 'Edit' },
        toolCallId: 'tool-1',
        ts: 1,
      },
      {
        id: 2,
        sessionId: 's1',
        filePath: '/repo/src/a.ts',
        kind: 'text',
        beforeBlob: null,
        afterBlob: null,
        beforeSnapshot: 'mid\n',
        afterSnapshot: '',
        metadata: { source: 'codex', changeKind: 'delete' },
        toolCallId: 'tool-2',
        ts: 2,
      },
    ]);

    const result = await getSessionFileFinalDiff('s1', '/repo/src/a.ts');

    expect(result.ok).toBe(true);
    expect(result.diff).toContain('deleted file mode 100644');
    expect(result.diff).toContain('--- a//repo/src/a.ts');
    expect(result.diff).toContain('+++ /dev/null');
    expect(result.diff).toContain('@@ -1,1 +0,0 @@');
    expect(result.diff).toContain('-old');
    expect(result.diff).not.toContain('-mid');
  });

  it('reports unchanged when recorded snapshots cancel out', async () => {
    fileChangeRepoMock.listForSession.mockReturnValue([
      {
        id: 1,
        sessionId: 's1',
        filePath: '/repo/src/a.ts',
        kind: 'text',
        beforeBlob: 'old',
        afterBlob: 'new',
        beforeSnapshot: 'same\n',
        afterSnapshot: 'same\n',
        metadata: { source: 'Edit' },
        toolCallId: 'tool-1',
        ts: 1,
      },
    ]);

    const result = await getSessionFileFinalDiff('s1', '/repo/src/a.ts');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unchanged');
    expect(result.source).toBe('recorded-snapshot');
  });

  it('falls back to recorded patch metadata for old records without snapshots', async () => {
    fileChangeRepoMock.listForSession.mockReturnValue([
      {
        id: 1,
        sessionId: 's1',
        filePath: '/repo/src/a.ts',
        kind: 'text',
        beforeBlob: null,
        afterBlob: null,
        metadata: { source: 'codex', diff: '@@ -1 +1 @@\n-old\n+new' },
        toolCallId: 'patch-1',
        ts: 1,
      },
    ]);

    const result = await getSessionFileFinalDiff('s1', '/repo/src/a.ts');

    expect(result.ok).toBe(true);
    expect(result.source).toBe('recorded-patch-fallback');
    expect(result.diff).toContain('@@ -1 +1 @@');
  });

  it('does not read git or the current working tree when snapshots are unavailable', async () => {
    fileChangeRepoMock.listForSession.mockReturnValue([
      {
        id: 1,
        sessionId: 's1',
        filePath: '/repo/src/a.ts',
        kind: 'text',
        beforeBlob: 'old',
        afterBlob: 'new',
        metadata: { source: 'Edit' },
        toolCallId: 'tool-1',
        ts: 1,
      },
    ]);

    const result = await getSessionFileFinalDiff('s1', '/repo/src/a.ts');

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('snapshot_unavailable');
    expect(result.message).toContain('记录快照');
  });

  it('targets the finite normalized relative and absolute candidates only', async () => {
    fileChangeRepoMock.listForSession.mockReturnValue([
      {
        id: 1,
        sessionId: 's1',
        filePath: 'src/a.ts',
        kind: 'text',
        beforeBlob: null,
        afterBlob: null,
        beforeSnapshot: 'old\n',
        afterSnapshot: 'new\n',
        metadata: { source: 'Edit' },
        toolCallId: null,
        ts: 1,
      },
    ]);

    await getSessionFileFinalDiff('s1', '/repo/src/a.ts');

    expect(fileChangeRepoMock.readPathBoundaries).toHaveBeenCalledWith(
      's1',
      expect.arrayContaining(['/repo/src/a.ts', 'src/a.ts']),
      undefined,
    );
    expect(fileChangeRepoMock.readPathBoundaries.mock.calls[0][1]).toHaveLength(2);
  });

  it('keeps the 4 MiB limit while keyset-reading same-path patch fallback pages', async () => {
    fileChangeRepoMock.listForSession.mockReturnValue([
      {
        id: 1,
        sessionId: 's1',
        filePath: '/repo/src/a.ts',
        kind: 'text',
        beforeBlob: null,
        afterBlob: null,
        metadata: {},
        toolCallId: null,
        ts: 1,
      },
    ]);
    fileChangeRepoMock.listPathPatchPage
      .mockReturnValueOnce({
        items: [{ id: 2, ts: 2, diff: 'x'.repeat(3 * 1024 * 1024) }],
        nextCursor: 'next',
      })
      .mockReturnValueOnce({
        items: [{ id: 1, ts: 1, diff: 'y'.repeat(2 * 1024 * 1024) }],
        nextCursor: null,
      });

    const result = await getSessionFileFinalDiff('s1', '/repo/src/a.ts');

    expect(result).toMatchObject({
      ok: false,
      source: 'recorded-patch-fallback',
      reason: 'too_large',
    });
    expect(fileChangeRepoMock.listPathPatchPage).toHaveBeenCalledTimes(2);
    expect(fileChangeRepoMock.listPathPatchPage.mock.calls[1][2]).toBe('next');
  });
});
