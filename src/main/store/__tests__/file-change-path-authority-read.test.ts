import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getFileChangeDbMock,
  type TestRow,
} from './file-change-repo-test-fixture';
import { fileChangeReadRepo } from '../file-change-read-repo';

const dbMock = getFileChangeDbMock();

function row(): TestRow {
  return {
    id: 7,
    session_id: 'session-a',
    file_path: '/workspaces/repo/deleted.ts',
    kind: 'text',
    before_blob: 'secret-snapshot',
    after_blob: null,
    metadata_json: JSON.stringify({
      __agentDeckCanonicalPathAuthorityV1: 'canonical:/workspaces/repo/deleted.ts',
      apiToken: 'must-not-project',
    }),
    tool_call_id: null,
    ts: 10,
  };
}

describe('file-change path authority descriptor reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.state.rows = [row()];
  });

  it('projects only the bounded authority before any payload lookup', () => {
    expect(fileChangeReadRepo.getDescriptor('session-a', 7)).toMatchObject({
      id: 7,
      pathAuthority: '/workspaces/repo/deleted.ts',
    });
    expect(fileChangeReadRepo.getPathDescriptor('session-a', [
      '/workspaces/repo/deleted.ts',
    ])).toMatchObject({ id: 7, pathAuthority: '/workspaces/repo/deleted.ts' });

    const statements = dbMock.db.prepare.mock.calls.map(([sql]) => sql as string);
    for (const sql of statements) {
      const projection = sql.slice(0, sql.indexOf('FROM'));
      expect(sql).not.toContain('file_snapshot_blobs');
      expect(projection).not.toMatch(/fc\.before_blob\s+AS before_blob/u);
      expect(projection).not.toMatch(/fc\.after_blob\s+AS after_blob/u);
      expect(projection).not.toMatch(/fc\.metadata_json\s+AS/u);
      expect(projection).toContain('AS path_authority');
    }
  });
});
