import { beforeEach, describe, expect, it, vi } from 'vitest';

const sessionRepoMock = vi.hoisted(() => ({ get: vi.fn() }));
const fileChangeRepoMock = vi.hoisted(() => ({ listForSession: vi.fn() }));

vi.mock('@main/store/session-repo', () => ({ sessionRepo: sessionRepoMock }));
vi.mock('@main/store/file-change-repo', () => ({ fileChangeRepo: fileChangeRepoMock }));

import { getSessionFileFinalDiff } from '../final-file-diff';

describe('getSessionFileFinalDiff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionRepoMock.get.mockReturnValue({ id: 's1', cwd: '/repo' });
    fileChangeRepoMock.listForSession.mockReturnValue([
      { id: 1, filePath: '/repo/src/a.ts', ts: 1, metadata: {} },
    ]);
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
        filePath: '/repo/src/a.ts',
        kind: 'text',
        beforeBlob: null,
        afterBlob: 'initial\n',
        beforeSnapshot: '',
        afterSnapshot: 'initial\n',
        metadata: { source: 'Write' },
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
});
