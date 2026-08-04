import { describe, expect, it } from 'vitest';

import {
  parseProjectListResult,
  parseProjectReference,
  parseSessionConsoleListParams,
  parseSessionConsoleListResult,
  parseSessionConsoleSummary,
} from './session-console';

const session = {
  id: 'session-1',
  adapterId: 'codex-cli',
  title: 'Session',
  status: 'idle',
  createdAt: 1,
  updatedAt: 2,
};

const project = {
  projectId: 'project-1',
  projectRef: 'opaque-project-1',
  alias: 'project',
  title: 'Project',
};

describe('cwd-free session-console contracts', () => {
  it('accepts exact detached summaries and rejects cwd-bearing projections', () => {
    expect(parseSessionConsoleSummary(session)).toEqual(session);
    expect(() => parseSessionConsoleSummary({ ...session, cwd: '/private/workspace' }))
      .toThrow('Invalid session-console contract field');
  });

  it('requires opaque non-path project references', () => {
    expect(parseProjectReference(project)).toEqual(project);
    expect(() => parseProjectReference({ ...project, projectRef: '/private/workspace' }))
      .toThrow('Invalid session-console contract field');
    expect(() => parseProjectReference({ ...project, cwd: '/private/workspace' }))
      .toThrow('Invalid session-console contract field');
  });

  it('enforces exact bounded request and response pages', () => {
    expect(parseSessionConsoleListParams({ cursor: 'cursor-1', limit: 25 })).toEqual({
      cursor: 'cursor-1',
      limit: 25,
    });
    expect(() => parseSessionConsoleListParams({ limit: 0 })).toThrow();
    expect(() => parseSessionConsoleListParams({ limit: 101 })).toThrow();
    expect(() => parseSessionConsoleListParams({ limit: 25, offset: 1 })).toThrow();

    expect(parseSessionConsoleListResult({
      sessions: [session], nextCursor: null, total: 1, revision: 2,
    }, 1)).toEqual({ sessions: [session], nextCursor: null, total: 1, revision: 2 });
    expect(() => parseSessionConsoleListResult({
      sessions: [session, { ...session, id: 'session-2' }],
      nextCursor: null,
      total: 2,
      revision: 2,
    }, 1)).toThrow();
  });

  it('rejects duplicate project identities and aliases', () => {
    expect(() => parseProjectListResult({
      projects: [project, { ...project, projectId: 'project-2', projectRef: 'opaque-project-2' }],
      nextCursor: null,
      total: 2,
      revision: 2,
    }, 2)).toThrow('Invalid session-console contract field');
  });
});
