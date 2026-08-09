// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sessionConsoleCapabilitiesFixture } from '@contracts/session-console-capabilities.fixture';
import type { RemoteHostIssueDto, RemoteHostProfileDto } from '@shared/remote-host';
import { RemoteIssuesPanel } from '@renderer/components/issues/RemoteIssuesPanel';
import { RemoteUserIntentLedger } from './remote-intent-ledger';
import type { RemoteSessionSourceView } from './source-types';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
  vi.clearAllMocks();
});

function issue(id: string, title: string, updatedAt = 2): RemoteHostIssueDto {
  return {
    id,
    title,
    description: 'Remote description',
    repro: null,
    kind: 'app-bug',
    status: 'open',
    severity: 'medium',
    sourceSessionId: 'session-a',
    cwd: 'repo',
    branchName: 'main',
    logsRef: null,
    resolutionSessionId: null,
    labels: ['remote'],
    createdAt: 1,
    updatedAt,
    resolvedAt: null,
    deletedAt: null,
    appendices: [],
    appendicesTruncated: false,
  };
}

function profile(id: string): RemoteHostProfileDto {
  return {
    id,
    label: id,
    scope: 'remote',
    endpoint: {
      hostname: `${id}.example.test`, port: 22, username: 'agentdeck',
      hostKeyFingerprint: 'SHA256:test',
    },
    credentials: { connectionCredentialConfigured: true },
  };
}

function source(
  id = 'remote-a',
  capabilities = new Set(['issues']),
  dataRevision = 0,
  addressableIdentityKey: string | null = `${id}:core-a:1`,
): RemoteSessionSourceView {
  return {
    addressableIdentityKey,
    busy: false,
    capabilities,
    dataRevision,
    error: null,
    eventLoadError: null,
    events: null,
    historySessions: [],
    hasMoreHistorySessions: false,
    hasMoreSessions: false,
    identity: `${id}:core-a:1`,
    loading: false,
    pendingBySession: new Map(),
    profile: profile(id),
    recoveringWorker: false,
    runtime: null,
    summaries: null,
    taskLoadError: null,
    tasks: null,
    sessionTotal: 0,
    selectedPending: null,
    selectedSession: null,
    selectedSessionId: null,
    sessions: [],
    state: null,
    usable: true,
    clearError: vi.fn(),
    createSession: vi.fn(),
    getSessionCapabilities: vi.fn(),
    listWorkspaceDirectories: vi.fn(),
    listFileChanges: vi.fn(),
    getFileChange: vi.fn(),
    getFileFinalDiff: vi.fn(),
    loadImageBlob: vi.fn(async () => ({ ok: false as const, reason: 'unsupported_source' as const })),
    interrupt: vi.fn(),
    loadMoreHistorySessions: vi.fn(),
    loadMoreSessions: vi.fn(),
    refresh: vi.fn(),
    respondPending: vi.fn(),
    selectSession: vi.fn(),
    send: vi.fn(),
    steer: vi.fn(),
    updateRuntime: vi.fn(),
  };
}

describe('RemoteIssuesPanel', () => {
  it('reuses the Local board/detail while routing a stable retry intent only to Remote', async () => {
    const initial = issue('issue-a', 'Remote issue');
    const updated = issue('issue-a', 'Updated issue', 3);
    const api = {
      listRemoteHostIssues: vi.fn(async () => ({
        issues: [initial], revision: 7, truncated: false,
      })),
      getRemoteHostIssue: vi.fn(async () => ({ issue: initial, revision: 7 })),
      updateRemoteHostIssue: vi.fn()
        .mockRejectedValueOnce(new Error('deadline exceeded'))
        .mockResolvedValueOnce({ issue: updated, revision: 8 }),
      softDeleteRemoteHostIssue: vi.fn(),
      undeleteRemoteHostIssue: vi.fn(),
      issuesGet: vi.fn(),
      issuesUpdate: vi.fn(),
      issuesSoftDelete: vi.fn(),
      issuesUndelete: vi.fn(),
    };
    window.api = api as unknown as typeof window.api;
    render(<RemoteIssuesPanel source={source()} />);

    fireEvent.click(await screen.findByText('Remote issue'));
    await waitFor(() => expect(api.getRemoteHostIssue).toHaveBeenCalledWith({
      profileId: 'remote-a', issueId: 'issue-a',
    }));
    const title = await screen.findByDisplayValue('Remote issue');
    fireEvent.change(title, { target: { value: 'Updated issue' } });
    fireEvent.click(screen.getByRole('button', { name: /保存/u }));
    expect((await screen.findByText('deadline exceeded')).textContent).toContain('deadline');
    fireEvent.click(screen.getByRole('button', { name: /保存/u }));

    await waitFor(() => expect(api.updateRemoteHostIssue).toHaveBeenCalledTimes(2));
    const [first, second] = api.updateRemoteHostIssue.mock.calls;
    expect(first?.[0]).toMatchObject({
      profileId: 'remote-a', issueId: 'issue-a', expectedRevision: 7,
      patch: { title: 'Updated issue' },
    });
    expect(second?.[0].intentId).toBe(first?.[0].intentId);
    expect(api.issuesGet).not.toHaveBeenCalled();
    expect(api.issuesUpdate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByDisplayValue('Updated issue')).toBeTruthy());
  });

  it('retires Issue intents only when the authoritative source snapshot removes an identity', async () => {
    const identityA = 'remote-a:core-a:1';
    const identityB = 'remote-b:core-a:1';
    const retainSources = vi.spyOn(RemoteUserIntentLedger.prototype, 'retainSources');
    const api = {
      listRemoteHostIssues: vi.fn(async ({ profileId }: { profileId: string }) => ({
        issues: [issue(`issue-${profileId}`, `Source ${profileId} issue`)],
        revision: 7,
        truncated: false,
      })),
    };
    window.api = api as unknown as typeof window.api;
    const view = render(<RemoteIssuesPanel source={source(
      'remote-a', new Set(['issues']), 0, `${identityA}\u0000${identityB}`,
    )} />);
    await waitFor(() => expect(retainSources).toHaveBeenCalledWith(new Set([identityA, identityB])));

    view.rerender(<RemoteIssuesPanel source={source(
      'remote-b', new Set(['issues']), 0, `${identityA}\u0000${identityB}`,
    )} />);
    view.rerender(<RemoteIssuesPanel source={source(
      'remote-a', new Set(['issues']), 0, `${identityA}\u0000${identityB}`,
    )} />);
    expect(retainSources).toHaveBeenCalledTimes(1);

    view.rerender(<RemoteIssuesPanel source={source('remote-b', new Set(['issues']), 0, identityB)} />);
    await waitFor(() => expect(retainSources).toHaveBeenLastCalledWith(new Set([identityB])));
    view.rerender(<RemoteIssuesPanel source={source('remote-a', new Set(['issues']), 0, identityA)} />);
    await waitFor(() => expect(retainSources).toHaveBeenLastCalledWith(new Set([identityA])));
  });

  it('fences a late list result after the Remote source identity changes', async () => {
    let resolveA!: (value: unknown) => void;
    const a = new Promise((resolve) => { resolveA = resolve; });
    const api = {
      listRemoteHostIssues: vi.fn((request: { profileId: string }) => request.profileId === 'remote-a'
        ? a
        : Promise.resolve({ issues: [issue('issue-b', 'Source B issue')], revision: 4, truncated: false })),
    };
    window.api = api as unknown as typeof window.api;
    const view = render(<RemoteIssuesPanel source={source('remote-a')} />);
    await waitFor(() => expect(api.listRemoteHostIssues).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 'remote-a' }),
    ));
    view.rerender(<RemoteIssuesPanel source={source('remote-b')} />);
    expect(await screen.findByText('Source B issue')).toBeTruthy();
    resolveA({ issues: [issue('issue-a', 'Late source A issue')], revision: 9, truncated: false });
    await Promise.resolve();
    expect(screen.queryByText('Late source A issue')).toBeNull();
  });

  it('does not regress the authoritative revision when a mutation response arrives late', async () => {
    const initial = issue('issue-a', 'Remote issue');
    const newer = issue('issue-a', 'Newer remote title', 4);
    const stale = issue('issue-a', 'Stale mutation title', 3);
    let resolveMutation!: (value: { issue: RemoteHostIssueDto; revision: number }) => void;
    const mutation = new Promise<{ issue: RemoteHostIssueDto; revision: number }>((resolve) => {
      resolveMutation = resolve;
    });
    let listCalls = 0;
    const api = {
      listRemoteHostIssues: vi.fn(async () => ++listCalls <= 2
        ? { issues: [initial], revision: 7, truncated: false }
        : { issues: [newer], revision: 9, truncated: false }),
      getRemoteHostIssue: vi.fn(async () => ({ issue: initial, revision: 7 })),
      updateRemoteHostIssue: vi.fn()
        .mockImplementationOnce(() => mutation)
        .mockResolvedValue({ issue: issue('issue-a', 'Third title', 5), revision: 10 }),
      softDeleteRemoteHostIssue: vi.fn(),
      undeleteRemoteHostIssue: vi.fn(),
    };
    window.api = api as unknown as typeof window.api;
    const view = render(<RemoteIssuesPanel source={source('remote-a', new Set(['issues']), 1)} />);
    fireEvent.click(await screen.findByText('Remote issue'));
    await waitFor(() => expect(api.getRemoteHostIssue).toHaveBeenCalledOnce());
    const title = await screen.findByDisplayValue('Remote issue');
    fireEvent.change(title, { target: { value: 'Stale mutation title' } });
    const save = screen.getByRole('button', { name: /保存/u }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(api.updateRemoteHostIssue).toHaveBeenCalledOnce());

    view.rerender(<RemoteIssuesPanel source={source('remote-a', new Set(['issues']), 2)} />);
    await screen.findByText('Newer remote title');
    resolveMutation({ issue: stale, revision: 8 });
    await waitFor(() => expect(screen.getByDisplayValue('Newer remote title')).toBeTruthy());
    expect(screen.queryByText('Stale mutation title')).toBeNull();

    fireEvent.change(screen.getByDisplayValue('Newer remote title'), {
      target: { value: 'Third title' },
    });
    fireEvent.click(screen.getByRole('button', { name: /保存/u }));
    await waitFor(() => expect(api.updateRemoteHostIssue).toHaveBeenCalledTimes(2));
    expect(api.updateRemoteHostIssue.mock.calls[1]?.[0]).toMatchObject({ expectedRevision: 9 });
  });

  it('does not invoke any Issue API when the capability is unavailable', () => {
    const listRemoteHostIssues = vi.fn();
    window.api = { listRemoteHostIssues } as unknown as typeof window.api;
    render(<RemoteIssuesPanel source={source('remote-a', new Set())} />);
    expect(screen.getByText(/不会回退读取 Local 数据/u)).toBeTruthy();
    expect(listRemoteHostIssues).not.toHaveBeenCalled();
  });

  it('uses the shared Remote new-session form and one Core-owned create-and-link request', async () => {
    const initial = issue('issue-a', 'Remote issue');
    const linked = {
      ...initial,
      resolutionSessionId: 'session-resolution',
      status: 'in-progress' as const,
      updatedAt: 3,
    };
    const api = {
      listRemoteHostIssues: vi.fn(async () => ({
        issues: [initial], revision: 7, truncated: false,
      })),
      getRemoteHostIssue: vi.fn(async () => ({ issue: initial, revision: 7 })),
      resolveRemoteHostIssueInNewSession: vi.fn(async () => ({
        issue: linked, revision: 9, sessionId: 'session-resolution',
      })),
    };
    window.api = api as unknown as typeof window.api;
    const current = source('remote-a', new Set([
      'issues', 'session-console.create', 'session-console.read',
    ]));
    current.getSessionCapabilities = vi.fn(async () =>
      sessionConsoleCapabilitiesFixture('codex-cli', 'repo'));
    render(<RemoteIssuesPanel source={current} />);

    fireEvent.click(await screen.findByText('Remote issue'));
    fireEvent.click(await screen.findByRole('button', { name: '新建处理会话' }));
    expect(await screen.findByRole('heading', { name: '新建处理会话' })).toBeTruthy();
    await waitFor(() => expect(current.getSessionCapabilities).toHaveBeenCalled());
    const create = await screen.findByRole('button', { name: '创建并关联' });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(create);

    await waitFor(() => expect(api.resolveRemoteHostIssueInNewSession).toHaveBeenCalledOnce());
    expect(api.resolveRemoteHostIssueInNewSession).toHaveBeenCalledWith(expect.objectContaining({
      profileId: 'remote-a',
      issueId: 'issue-a',
      issueUpdatedAt: 2,
      expectedRevision: 7,
      adapterId: 'codex-cli',
      workingDirectory: 'repo',
      initialMessage: expect.stringContaining('请处理 Issue：Remote issue'),
      capabilityRevision: `sha256:${'a'.repeat(64)}`,
    }));
    expect(await screen.findByText('session-resolution')).toBeTruthy();
  });
});
