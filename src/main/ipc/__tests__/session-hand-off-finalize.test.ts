import { beforeEach, describe, expect, it, vi } from 'vitest';
import log from 'electron-log/main';
import { SessionRowMissingError } from '@main/store/session-repo';
import { archiveSourceSessionWithEmit } from '../session-hand-off-finalize';

const logger = log.scope('ipc-sessions-handoff');

function deps(input: {
  getSession?: () => unknown | null;
  archive?: () => Promise<void>;
} = {}) {
  return {
    getSession: vi.fn(input.getSession ?? (() => ({ id: 'source' }))),
    archive: vi.fn(input.archive ?? (async () => undefined)),
    emitArchiveFailed: vi.fn(),
  };
}

describe('archiveSourceSessionWithEmit', () => {
  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
  });

  it('archives an existing source without emitting a failure', async () => {
    const input = deps();
    await expect(archiveSourceSessionWithEmit('source', input)).resolves.toEqual({ ok: true });
    expect(input.getSession).toHaveBeenCalledWith('source');
    expect(input.archive).toHaveBeenCalledWith('source');
    expect(input.emitArchiveFailed).not.toHaveBeenCalled();
  });

  it('reports a generic archive failure without invalidating the successor', async () => {
    const input = deps({ archive: async () => { throw new Error('FK failure'); } });
    await expect(archiveSourceSessionWithEmit('source', input)).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('FK failure'),
      reasonKind: 'archive-throw',
    });
    expect(input.emitArchiveFailed).toHaveBeenCalledWith({
      sessionId: 'source',
      toolName: 'SessionHandOffCommit',
      reason: expect.stringContaining('FK failure'),
      reasonKind: 'archive-throw',
    });
  });

  it('classifies a post-probe missing-row race separately', async () => {
    const input = deps({ archive: async () => { throw new SessionRowMissingError('source'); } });
    await expect(archiveSourceSessionWithEmit('source', input)).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('race window'),
      reasonKind: 'row-missing',
    });
    expect(input.emitArchiveFailed).toHaveBeenCalledWith({
      sessionId: 'source',
      toolName: 'SessionHandOffCommit',
      reason: expect.stringContaining('race window'),
      reasonKind: 'row-missing',
    });
  });

  it('stringifies non-Error archive failures', async () => {
    const input = deps({ archive: async () => { throw 'opaque failure'; } });
    await archiveSourceSessionWithEmit('source', input);
    expect(input.emitArchiveFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: expect.stringContaining('opaque failure'),
        reasonKind: 'archive-throw',
      }),
    );
  });

  it('reports a source removed before archive and skips the write', async () => {
    const input = deps({ getSession: () => null });
    await expect(archiveSourceSessionWithEmit('source', input)).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('not in sessions table'),
      reasonKind: 'row-missing',
    });
    expect(input.archive).not.toHaveBeenCalled();
    expect(input.emitArchiveFailed).toHaveBeenCalledWith({
      sessionId: 'source',
      toolName: 'SessionHandOffCommit',
      reason: expect.stringContaining('not in sessions table'),
      reasonKind: 'row-missing',
    });
  });

  it('reports a probe failure separately and skips archive', async () => {
    const input = deps({ getSession: () => { throw new Error('SQLite locked'); } });
    await expect(archiveSourceSessionWithEmit('source', input)).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('probe getSession threw'),
      reasonKind: 'probe-throw',
    });
    expect(input.archive).not.toHaveBeenCalled();
    expect(input.emitArchiveFailed).toHaveBeenCalledWith({
      sessionId: 'source',
      toolName: 'SessionHandOffCommit',
      reason: expect.stringContaining('probe getSession threw'),
      reasonKind: 'probe-throw',
    });
  });
});
