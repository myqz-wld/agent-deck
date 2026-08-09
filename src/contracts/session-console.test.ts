import { describe, expect, it } from 'vitest';

import {
  parseProjectListResult,
  parseProjectReference,
  parseSessionConsoleCreateParams,
  parseSessionConsoleGetResult,
  parseSessionConsoleListParams,
  parseSessionConsoleListResult,
  parseSessionConsoleSummary,
} from './session-console';
import { sessionConsoleCreateOptionsFixture } from './session-console-capabilities.fixture';

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

  it('binds a targeted session result to the requested identity', () => {
    expect(parseSessionConsoleGetResult({ session, revision: 2 }, 'session-1').session)
      .toEqual(session);
    expect(() => parseSessionConsoleGetResult({ session, revision: 2 }, 'session-2'))
      .toThrow('Invalid session-console contract field');
  });

  it('accepts only normalized workspace-relative project references', () => {
    expect(parseProjectReference(project)).toEqual(project);
    expect(parseProjectReference({ ...project, projectRef: '.' }).projectRef).toBe('.');
    expect(parseProjectReference({ ...project, projectRef: 'repo/subdir' }).projectRef)
      .toBe('repo/subdir');
    expect(() => parseProjectReference({ ...project, projectRef: '/private/workspace' }))
      .toThrow('Invalid session-console contract field');
    expect(() => parseProjectReference({ ...project, projectRef: '../outside' }))
      .toThrow('Invalid session-console contract field');
    expect(() => parseProjectReference({ ...project, projectRef: 'repo/../outside' }))
      .toThrow('Invalid session-console contract field');
    expect(() => parseProjectReference({ ...project, cwd: '/private/workspace' }))
      .toThrow('Invalid session-console contract field');
    expect(parseSessionConsoleCreateParams({
      adapterId: 'codex-cli', capabilityRevision: `sha256:${'a'.repeat(64)}`,
      attachments: [],
      initialMessage: 'Inspect the repository', workingDirectory: 'repo/subdir',
      options: sessionConsoleCreateOptionsFixture(),
    }).workingDirectory).toBe('repo/subdir');
    expect(() => parseSessionConsoleCreateParams({
      adapterId: 'codex-cli', capabilityRevision: `sha256:${'a'.repeat(64)}`,
      attachments: [],
      initialMessage: '   ', workingDirectory: '.',
      options: sessionConsoleCreateOptionsFixture(),
    })).toThrow('Invalid session-console contract field');
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
