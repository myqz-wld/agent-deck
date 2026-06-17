import { beforeEach, describe, expect, it, vi } from 'vitest';

interface TestRow {
  id: number;
  session_id: string;
  file_path: string;
  kind: string;
  before_blob: string | null;
  after_blob: string | null;
  before_snapshot: string | null;
  after_snapshot: string | null;
  metadata_json: string;
  tool_call_id: string | null;
  ts: number;
}

const dbMock = vi.hoisted(() => {
  const state = { rows: [] as TestRow[] };
  const db = {
    prepare: vi.fn(() => ({
      all: vi.fn(() => state.rows),
      get: vi.fn(() => ({ c: state.rows.length })),
      run: vi.fn(() => ({ lastInsertRowid: 1 })),
    })),
  };
  return { state, db };
});

vi.mock('../db', () => ({
  getDb: () => dbMock.db,
}));

import { fileChangeRepo } from '../file-change-repo';

function row(overrides: Partial<TestRow> = {}): TestRow {
  return {
    id: 1,
    session_id: 's1',
    file_path: '/repo/a.ts',
    kind: 'text',
    before_blob: null,
    after_blob: null,
    before_snapshot: null,
    after_snapshot: null,
    metadata_json: JSON.stringify({
      source: 'codex',
      changeKind: 'update',
      patchStatus: 'completed',
      diff: '@@ -1 +1 @@\n-old\n+new',
    }),
    tool_call_id: 'patch-1',
    ts: 1,
    ...overrides,
  };
}

describe('fileChangeRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.state.rows = [];
  });

  it('filters historical Codex no-op file changes while preserving real changes', () => {
    dbMock.state.rows = [
      row({
        id: 1,
        file_path: '/repo/noop-empty.ts',
        metadata_json: JSON.stringify({
          source: 'codex',
          changeKind: 'update',
          patchStatus: 'completed',
          diff: '',
        }),
      }),
      row({
        id: 2,
        file_path: '/repo/noop-same.ts',
        metadata_json: JSON.stringify({
          source: 'codex',
          changeKind: 'update',
          patchStatus: 'completed',
          diff: '@@ -1 +1 @@\n-same\n+same',
        }),
      }),
      row({
        id: 3,
        file_path: '/repo/failed.ts',
        metadata_json: JSON.stringify({
          source: 'codex',
          changeKind: 'update',
          patchStatus: 'failed',
          diff: '@@ -1 +1 @@\n-old\n+new',
        }),
      }),
      row({ id: 4, file_path: '/repo/real.ts' }),
    ];

    expect(fileChangeRepo.listForSession('s1').map((r) => r.filePath)).toEqual([
      '/repo/real.ts',
    ]);
  });

  it('does not apply Codex no-op filtering to non-Codex or non-text records', () => {
    dbMock.state.rows = [
      row({
        id: 1,
        file_path: '/repo/claude-empty.ts',
        metadata_json: JSON.stringify({ source: 'Edit', diff: '' }),
      }),
      row({
        id: 2,
        file_path: '/repo/image.png',
        kind: 'image',
        metadata_json: JSON.stringify({
          source: 'codex',
          changeKind: 'update',
          patchStatus: 'completed',
          diff: '',
        }),
      }),
    ];

    expect(fileChangeRepo.listForSession('s1').map((r) => r.filePath)).toEqual([
      '/repo/claude-empty.ts',
      '/repo/image.png',
    ]);
  });
});
