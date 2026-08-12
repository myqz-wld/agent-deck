import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initDb } from '../db';
import { fileChangeReadRepo } from '../file-change-read-repo';
import { fileChangeRepo } from '../file-change-repo';
import { withStoredFileChangePathAuthority } from '@shared/file-change-path-authority';
import { bindingAvailable } from './_binding-probe';
import { getSessionFileFinalDiff } from '@main/session/final-file-diff';

describe.skipIf(!bindingAvailable)('file-change canonical path authority SQLite projection', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-deck-path-authority-db-'));
    const db = initDb({
      databasePath: join(root, 'agent-deck.db'),
      diagnostics: { info: vi.fn(), warn: vi.fn() },
    });
    db.prepare(`
      INSERT INTO sessions
        (id, agent_id, cwd, title, source, lifecycle, activity,
         started_at, last_event_at, hidden_from_history, spawn_depth)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('session-a', 'codex-cli', '/workspaces/repo', 'Session', 'sdk',
      'active', 'idle', 1, 1, 0, 0);
  });

  afterEach(() => {
    closeDb();
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the bounded authority without loading snapshot content', () => {
    const path = '/workspaces/repo/deleted.ts';
    const id = fileChangeRepo.insert({
      sessionId: 'session-a',
      filePath: path,
      kind: 'text',
      beforeBlob: 'before',
      afterBlob: null,
      beforeSnapshot: 'before snapshot',
      afterSnapshot: '',
      metadata: withStoredFileChangePathAuthority({ source: 'Edit' }, path),
      toolCallId: null,
      ts: 2,
    });

    expect(fileChangeReadRepo.getDescriptor('session-a', id)).toMatchObject({
      filePath: path,
      pathAuthority: path,
    });
    expect(fileChangeReadRepo.getPathDescriptor('session-a', [path])).toMatchObject({
      id,
      pathAuthority: path,
    });
  });

  it('rejects mixed-authority history before final-diff snapshot content is loaded', async () => {
    const path = '/workspaces/repo/file.ts';
    fileChangeRepo.insert({
      sessionId: 'session-a',
      filePath: path,
      kind: 'text',
      beforeBlob: 'outside-private-content',
      afterBlob: 'mid',
      beforeSnapshot: 'outside-private-content',
      afterSnapshot: 'mid',
      metadata: withStoredFileChangePathAuthority(
        { source: 'Edit' },
        '/private/provider-home/file.ts',
      ),
      toolCallId: null,
      ts: 2,
    });
    fileChangeRepo.insert({
      sessionId: 'session-a',
      filePath: path,
      kind: 'text',
      beforeBlob: 'mid',
      afterBlob: 'safe',
      beforeSnapshot: 'mid',
      afterSnapshot: 'safe',
      metadata: withStoredFileChangePathAuthority({ source: 'Edit' }, path),
      toolCallId: null,
      ts: 3,
    });

    expect(fileChangeReadRepo.readPathBoundaries('session-a', [path], path)).toBeNull();
    await expect(getSessionFileFinalDiff('session-a', path, path)).resolves.toMatchObject({
      ok: false,
      reason: 'not_in_session',
      diff: null,
    });
  });

  it('keeps authority-matched patch fallback available when snapshots are absent', async () => {
    const path = '/workspaces/repo/patch-only.ts';
    fileChangeRepo.insert({
      sessionId: 'session-a',
      filePath: path,
      kind: 'text',
      beforeBlob: null,
      afterBlob: null,
      metadata: withStoredFileChangePathAuthority({
        source: 'codex',
        changeKind: 'update',
        diff: '@@ -1 +1 @@\n-old\n+new',
      }, path),
      toolCallId: null,
      ts: 4,
    });

    await expect(getSessionFileFinalDiff('session-a', path, path)).resolves.toMatchObject({
      ok: true,
      source: 'recorded-patch-fallback',
      diff: expect.stringContaining('+new'),
    });
  });
});
