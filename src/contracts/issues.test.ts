import { describe, expect, it } from 'vitest';

import {
  parseIssueGetResult,
  parseIssueListParams,
  parseIssueListResult,
  parseIssueMutationResult,
  parseIssueResolveInNewSessionParams,
  parseIssueResolveInNewSessionResult,
  parseIssueUpdateParams,
} from './issues';
import { sessionConsoleCreateOptionsFixture } from './session-console-capabilities.fixture';

const issue = {
  id: 'issue-a',
  title: 'Remote issue',
  description: 'Description',
  repro: null,
  kind: 'app-bug',
  status: 'open',
  severity: 'high',
  sourceSessionId: 'session-a',
  cwd: 'project-a',
  branchName: 'feature/remote',
  logsRef: {
    date: '2026-08-07',
    tsRange: { start: 1, end: 2 },
    scopes: ['provider'],
    note: 'bounded',
  },
  resolutionSessionId: null,
  labels: ['remote'],
  createdAt: 1,
  updatedAt: 2,
  resolvedAt: null,
  deletedAt: null,
  appendices: [{
    id: 1,
    issueId: 'issue-a',
    body: 'context',
    logsRef: null,
    appendedSessionId: 'session-a',
    appendedAt: 3,
  }],
  appendicesTruncated: false,
} as const;

describe('Remote issue contract', () => {
  it('accepts fixed bounded list filters and exact issue projections', () => {
    expect(parseIssueListParams({
      statuses: ['open', 'in-progress'],
      kinds: ['app-bug'],
      titleKeyword: null,
      includeDeleted: false,
      limit: 50,
      offset: 0,
    })).toMatchObject({ limit: 50, offset: 0 });
    expect(parseIssueListResult({ issues: [issue], revision: 7, truncated: false }, 50))
      .toEqual({ issues: [issue], revision: 7, truncated: false });
    expect(parseIssueGetResult({ issue, revision: 7 }).issue?.id).toBe('issue-a');
    expect(parseIssueMutationResult({ issue, revision: 8 }).revision).toBe(8);
    expect(() => parseIssueGetResult({ issue, revision: 7 }, 'issue-b')).toThrow();
    expect(() => parseIssueMutationResult({ issue, revision: 8 }, 'issue-b')).toThrow();
  });

  it('accepts only the editable issue patch and rejects empty or extra patches', () => {
    expect(parseIssueUpdateParams({
      issueId: 'issue-a',
      patch: { status: 'resolved', labels: ['closed'] },
    })).toEqual({ issueId: 'issue-a', patch: { status: 'resolved', labels: ['closed'] } });
    expect(() => parseIssueUpdateParams({ issueId: 'issue-a', patch: {} })).toThrow();
    expect(() => parseIssueUpdateParams({
      issueId: 'issue-a', patch: { resolutionSessionId: 'session-b' },
    })).toThrow();
  });

  it('binds one exact Workspace-bounded session create to the presented issue version', () => {
    const create = {
      adapterId: 'codex-cli',
      attachments: [],
      capabilityRevision: `sha256:${'a'.repeat(64)}`,
      initialMessage: 'Resolve the issue',
      options: sessionConsoleCreateOptionsFixture(),
      projectTrust: { revision: `sha256:${'b'.repeat(64)}`, grant: false },
      workingDirectory: 'repo/subdir',
    };
    expect(parseIssueResolveInNewSessionParams({
      issueId: 'issue-a', issueUpdatedAt: 2, create,
    })).toEqual({ issueId: 'issue-a', issueUpdatedAt: 2, create });
    expect(parseIssueResolveInNewSessionResult({
      issue: { ...issue, resolutionSessionId: 'session-b' },
      revision: 9,
      sessionId: 'session-b',
    }, 'issue-a')).toMatchObject({ revision: 9, sessionId: 'session-b' });
    expect(() => parseIssueResolveInNewSessionResult({
      issue: { ...issue, resolutionSessionId: 'session-other' },
      revision: 9,
      sessionId: 'session-b',
    }, 'issue-a')).toThrow();
    expect(() => parseIssueResolveInNewSessionParams({
      issueId: 'issue-a', issueUpdatedAt: 2, create: { ...create, workingDirectory: '../outside' },
    })).toThrow();
    expect(() => parseIssueResolveInNewSessionResult({
      issue: { ...issue, resolutionSessionId: 'session-b' },
      revision: 9,
      sessionId: 'session-b',
      leakedPath: '/private',
    })).toThrow();
  });

  it('rejects absolute or traversing Workspace paths and mismatched appendices', () => {
    expect(() => parseIssueGetResult({ issue: { ...issue, cwd: '/srv/workspace' }, revision: 1 }))
      .toThrow();
    expect(() => parseIssueGetResult({ issue: { ...issue, cwd: '../outside' }, revision: 1 }))
      .toThrow();
    expect(() => parseIssueGetResult({
      issue: {
        ...issue,
        appendices: [{ ...issue.appendices[0], issueId: 'issue-b' }],
      },
      revision: 1,
    })).toThrow();
  });

  it('rejects Feishu-sized or unexpected wrapper fields before use', () => {
    expect(() => parseIssueListParams({
      statuses: [], kinds: [], titleKeyword: null, includeDeleted: false,
      limit: 101, offset: 0,
    })).toThrow();
    expect(() => parseIssueListResult({
      issues: [{ ...issue, hidden: true }], revision: 1, truncated: false,
    }, 10)).toThrow();
  });
});
