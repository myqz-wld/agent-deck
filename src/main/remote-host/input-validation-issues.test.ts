import { describe, expect, it } from 'vitest';

import { sessionConsoleCreateOptionsFixture } from '@contracts/session-console-capabilities.fixture';
import {
  parseRemoteHostIssueListRequest,
  parseRemoteHostIssueMutationTarget,
  parseRemoteHostIssueResolveSession,
  parseRemoteHostIssueTarget,
  parseRemoteHostIssueUpdate,
} from './input-validation-issues';

const EXPECTED_AUTHORITY = {
  authoritativeCoreId: 'core-a',
  workerGeneration: 3,
};

describe('remote issue input validation', () => {
  it('accepts exact bounded list and target requests', () => {
    expect(parseRemoteHostIssueListRequest({
      profileId: 'remote-a',
      statuses: ['open', 'in-progress'],
      kinds: ['app-bug'],
      titleKeyword: 'worker',
      includeDeleted: false,
      limit: 100,
      offset: 0,
    })).toMatchObject({ profileId: 'remote-a', limit: 100, offset: 0 });
    expect(parseRemoteHostIssueTarget({
      profileId: 'remote-a', issueId: 'issue-a',
    })).toEqual({ profileId: 'remote-a', issueId: 'issue-a' });
  });

  it('accepts only editable patch fields with a revision-bound intent', () => {
    expect(parseRemoteHostIssueUpdate({
      profileId: 'remote-a',
      issueId: 'issue-a',
      patch: { title: 'Updated', status: 'in-progress', labels: ['remote'] },
      expectedAuthority: EXPECTED_AUTHORITY,
      expectedRevision: 7,
      intentId: 'intent-issue-a',
    })).toMatchObject({ expectedRevision: 7, intentId: 'intent-issue-a' });
    expect(parseRemoteHostIssueMutationTarget({
      profileId: 'remote-a', issueId: 'issue-a', expectedRevision: 7,
      expectedAuthority: EXPECTED_AUTHORITY,
      intentId: 'intent-delete-a',
    })).toMatchObject({ expectedRevision: 7 });
    expect(() => parseRemoteHostIssueUpdate({
      profileId: 'remote-a', issueId: 'issue-a', patch: { cwd: '/etc' },
      expectedAuthority: EXPECTED_AUTHORITY,
      expectedRevision: 7, intentId: 'intent-issue-a',
    })).toThrow('invalid issue update request');
  });

  it('rejects present undefined fields, negative revisions, and extra authority', () => {
    expect(() => parseRemoteHostIssueListRequest({
      profileId: 'remote-a', statuses: [], kinds: [], titleKeyword: undefined,
      includeDeleted: false, limit: 100, offset: 0,
    })).toThrow('invalid remote host input');
    expect(() => parseRemoteHostIssueMutationTarget({
      profileId: 'remote-a', issueId: 'issue-a', expectedRevision: -1,
      expectedAuthority: EXPECTED_AUTHORITY,
      intentId: 'intent-delete-a',
    })).toThrow('invalid issue mutation request');
    expect(() => parseRemoteHostIssueTarget({
      profileId: 'remote-a', issueId: 'issue-a', accessCredentialId: 'forged',
    })).toThrow('unexpected fields');
  });

  it('accepts one exact Workspace-bounded issue resolution create request', () => {
    const request = {
      profileId: 'remote-a',
      issueId: 'issue-a',
      issueUpdatedAt: 2,
      expectedRevision: 7,
      expectedAuthority: EXPECTED_AUTHORITY,
      intentId: 'intent-resolve-a',
      adapterId: 'codex-cli',
      attachments: [],
      capabilityRevision: `sha256:${'a'.repeat(64)}`,
      initialMessage: 'Resolve the issue',
      options: sessionConsoleCreateOptionsFixture(),
      workingDirectory: 'repo',
    };
    expect(parseRemoteHostIssueResolveSession(request)).toMatchObject({
      profileId: 'remote-a', issueId: 'issue-a', issueUpdatedAt: 2, expectedRevision: 7,
    });
    expect(() => parseRemoteHostIssueResolveSession({
      ...request, workingDirectory: '../outside',
    })).toThrow();
    expect(() => parseRemoteHostIssueResolveSession({
      ...request, topology: 'relay',
    })).toThrow('unexpected fields');
  });
});
