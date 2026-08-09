import { describe, expect, it, vi } from 'vitest';

import { sessionConsoleCreateOptionsFixture } from '@contracts/session-console-capabilities.fixture';
import type { RemoteHostScopedClient } from './service-scope';
import { RemoteHostIssueController } from './service-issues';

const ISSUE = {
  id: 'issue-a',
  title: 'Remote issue',
  description: 'Description',
  repro: null,
  kind: 'app-bug',
  status: 'open' as const,
  severity: 'medium' as const,
  sourceSessionId: 'session-a',
  cwd: 'repo',
  branchName: 'main',
  logsRef: null,
  resolutionSessionId: null,
  labels: ['remote'],
  createdAt: 1,
  updatedAt: 2,
  resolvedAt: null,
  deletedAt: null,
  appendices: [],
  appendicesTruncated: false,
};

function harness(result: unknown) {
  const clientRequest = vi.fn(async () => result);
  const scope: RemoteHostScopedClient = {
    client: { request: clientRequest } as unknown as RemoteHostScopedClient['client'],
    profileEpoch: 1,
    profileId: 'remote-a',
    sourceEpoch: 2,
  };
  const request = vi.fn(async (
    profileId: string,
    method: string,
    run: (value: RemoteHostScopedClient) => Promise<unknown>,
    _additionalMethods?: readonly string[],
  ) => {
    expect(profileId).toBe('remote-a');
    expect(method).toMatch(/^issues\./);
    return run(scope);
  });
  const mutationId = vi.fn((operation: string, profileId: string, intentId: string) =>
    `electron-${operation}-${profileId}-${intentId}`);
  return {
    clientRequest,
    controller: new RemoteHostIssueController(request as never, mutationId),
    mutationId,
    request,
  };
}

describe('RemoteHostIssueController', () => {
  it('preserves the authoritative revision for list and get reads', async () => {
    const list = harness({ issues: [ISSUE], revision: 7, truncated: false });
    await expect(list.controller.list({
      profileId: 'remote-a', statuses: ['open'], kinds: [], titleKeyword: null,
      includeDeleted: false, limit: 100, offset: 0,
    })).resolves.toMatchObject({ revision: 7, issues: [{ cwd: 'repo' }] });
    expect(list.clientRequest).toHaveBeenCalledWith('issues.list', {
      statuses: ['open'], kinds: [], titleKeyword: null, includeDeleted: false,
      limit: 100, offset: 0,
    }, { deadlineMs: 45_000 });

    const get = harness({ issue: ISSUE, revision: 8 });
    await expect(get.controller.get({
      profileId: 'remote-a', issueId: 'issue-a',
    })).resolves.toMatchObject({ revision: 8, issue: { id: 'issue-a' } });
  });

  it('binds mutations to the captured revision and renderer intent', async () => {
    const context = harness({ issue: { ...ISSUE, title: 'Updated' }, revision: 8 });
    await expect(context.controller.update({
      profileId: 'remote-a',
      issueId: 'issue-a',
      patch: { title: 'Updated' },
      expectedRevision: 7,
      intentId: 'intent-a',
    })).resolves.toMatchObject({ revision: 8, issue: { title: 'Updated' } });
    expect(context.clientRequest).toHaveBeenCalledWith(
      'issues.update',
      { issueId: 'issue-a', patch: { title: 'Updated' } },
      {
        deadlineMs: 45_000,
        expectedRevision: 7,
        idempotencyKey: 'electron-update-remote-a-intent-a',
      },
    );
    expect(context.mutationId).toHaveBeenCalledWith('update', 'remote-a', 'intent-a');
  });

  it('rejects a host result that escapes the Workspace contract', async () => {
    const context = harness({ issue: { ...ISSUE, cwd: '/etc' }, revision: 7 });
    await expect(context.controller.get({
      profileId: 'remote-a', issueId: 'issue-a',
    })).rejects.toThrow();
  });

  it('rejects targeted Issue and resolution identity mismatches', async () => {
    const get = harness({ issue: { ...ISSUE, id: 'issue-b' }, revision: 7 });
    await expect(get.controller.get({
      profileId: 'remote-a', issueId: 'issue-a',
    })).rejects.toThrow();

    const update = harness({ issue: { ...ISSUE, id: 'issue-b' }, revision: 8 });
    await expect(update.controller.update({
      profileId: 'remote-a', issueId: 'issue-a', patch: { title: 'Updated' },
      expectedRevision: 7, intentId: 'intent-a',
    })).rejects.toThrow();

    const resolution = harness({
      issue: { ...ISSUE, resolutionSessionId: 'session-other', status: 'in-progress' },
      revision: 9,
      sessionId: 'session-resolution',
    });
    const options = sessionConsoleCreateOptionsFixture();
    await expect(resolution.controller.resolveInNewSession({
      profileId: 'remote-a', issueId: 'issue-a', issueUpdatedAt: 2,
      expectedRevision: 7, intentId: 'intent-resolve-a', adapterId: 'codex-cli',
      attachments: [], capabilityRevision: `sha256:${'a'.repeat(64)}`,
      initialMessage: 'Resolve', options, workingDirectory: 'repo',
    })).rejects.toThrow();
  });

  it('requires Issue and session-create capabilities for an atomic resolution session', async () => {
    const context = harness({
      issue: { ...ISSUE, resolutionSessionId: 'session-resolution', status: 'in-progress' },
      revision: 9,
      sessionId: 'session-resolution',
    });
    const options = sessionConsoleCreateOptionsFixture();
    await expect(context.controller.resolveInNewSession({
      profileId: 'remote-a',
      issueId: 'issue-a',
      issueUpdatedAt: 2,
      expectedRevision: 7,
      intentId: 'intent-resolve-a',
      adapterId: 'codex-cli',
      attachments: [],
      capabilityRevision: `sha256:${'a'.repeat(64)}`,
      initialMessage: 'Resolve the issue',
      options,
      workingDirectory: 'repo',
    })).resolves.toMatchObject({ sessionId: 'session-resolution', revision: 9 });
    expect(context.request).toHaveBeenCalledWith(
      'remote-a',
      'issues.resolve-in-new-session',
      expect.any(Function),
      ['session.console.create', 'session.console.capabilities'],
    );
    expect(context.clientRequest).toHaveBeenCalledWith(
      'issues.resolve-in-new-session',
      {
        issueId: 'issue-a',
        issueUpdatedAt: 2,
        create: {
          adapterId: 'codex-cli',
          attachments: [],
          capabilityRevision: `sha256:${'a'.repeat(64)}`,
          initialMessage: 'Resolve the issue',
          options,
          workingDirectory: 'repo',
        },
      },
      {
        deadlineMs: 45_000,
        expectedRevision: 7,
        idempotencyKey: 'electron-resolve-in-new-session-remote-a-intent-resolve-a',
      },
    );
  });
});
