import { describe, expect, it, vi } from 'vitest';

import {
  issueRemoteOwnerGrantClaim,
  type AuthenticatedClientAccessContext,
  type CoreMethod,
  type JsonObject,
  type JsonValue,
} from '@contracts/index';
import { sessionConsoleCreateOptionsFixture } from '@contracts/session-console-capabilities.fixture';
import type { DaemonCoreRuntime, DaemonRequestInput } from '@hosts/daemon';
import type { IssueRecord } from '@shared/types';
import {
  ServerCoreIssueRuntime,
  type ServerCoreIssueMetadataPort,
} from './issue-runtime';
import type {
  ServerCoreMutationClaim,
  ServerCoreMutationIdentity,
} from './runtime-metadata-store';

const desktop: AuthenticatedClientAccessContext = {
  kind: 'authenticated-client',
  topology: 'full',
  instanceId: 'instance-a',
  clientId: 'desktop-a',
  transport: 'ssh',
  connectionScope: 'credential-a',
  authority: 'owner-equivalent',
  surface: 'desktop',
  grant: issueRemoteOwnerGrantClaim('desktop'),
};

function issue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    id: 'issue-a',
    title: 'Workspace failure',
    description: 'failed under /workspaces/repo',
    repro: null,
    kind: 'app-bug',
    status: 'open',
    severity: 'high',
    sourceSessionId: 'session-a',
    cwd: '/workspaces/repo',
    branchName: 'feature/remote',
    logsRef: null,
    resolutionSessionId: null,
    labels: ['remote'],
    createdAt: 1,
    updatedAt: 2,
    resolvedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

class Metadata implements ServerCoreIssueMetadataPort {
  revision = 4;
  failAppendOnce = false;
  readonly ledger = new Map<string, { identity: ServerCoreMutationIdentity; result?: JsonValue; revision?: number }>();

  currentRevision(): number { return this.revision; }
  appendChange(): number {
    if (this.failAppendOnce) {
      this.failAppendOnce = false;
      throw new Error('simulated change publication failure');
    }
    return ++this.revision;
  }
  claimMutation(
    identity: ServerCoreMutationIdentity,
    _now?: number,
    expectedRevision?: number,
  ): ServerCoreMutationClaim {
    const key = identity.idempotencyKey;
    const existing = this.ledger.get(key);
    if (existing) {
      if (existing.identity.requestFingerprint !== identity.requestFingerprint) return { state: 'conflict' };
      if (existing.result === undefined || existing.revision === undefined) return { state: 'uncertain' };
      return { state: 'completed', result: existing.result, revision: existing.revision };
    }
    if (expectedRevision !== this.revision) return { state: 'conflict' };
    this.ledger.set(key, { identity });
    return { state: 'claimed' };
  }
  completeMutation(identity: ServerCoreMutationIdentity, result: JsonValue, revision: number): void {
    const row = this.ledger.get(identity.idempotencyKey)!;
    row.result = result;
    row.revision = revision;
  }
  releaseMutationClaim(identity: ServerCoreMutationIdentity): void {
    const row = this.ledger.get(identity.idempotencyKey);
    if (!row || row.identity.requestFingerprint !== identity.requestFingerprint) {
      throw new Error('claim missing');
    }
    this.ledger.delete(identity.idempotencyKey);
  }
}

function request(
  method: CoreMethod,
  params: JsonObject,
  options: { expectedRevision?: number; idempotencyKey?: string } = {},
): DaemonRequestInput {
  return {
    access: desktop,
    requestId: `request-${method}`,
    method,
    params,
    idempotencyKey: options.idempotencyKey ?? null,
    expectedRevision: options.expectedRevision ?? null,
    deadlineAt: null,
    signal: new AbortController().signal,
  };
}

function harness(issueOverrides: Partial<IssueRecord> = {}) {
  let current = issue(issueOverrides);
  const metadata = new Metadata();
  const update = vi.fn((id: string, patch: Partial<IssueRecord>) => {
    if (id !== current.id) return null;
    current = { ...current, ...patch, updatedAt: current.updatedAt + 1 };
    return current;
  });
  const base: DaemonCoreRuntime = {
    supportedMethods: ['system.health'],
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    currentRevision: () => metadata.currentRevision(),
    execute: vi.fn(async () => ({ result: { ok: true, revision: 4 }, revision: 4 })),
  };
  const createSession = vi.fn(async () => ({ sessionId: 'session-resolution', revision: 5 }));
  const rollbackSession = vi.fn(async () => undefined);
  const linkResolutionSession = vi.fn((id: string, sessionId: string, expectedUpdatedAt: number) => {
    if (id !== current.id || current.updatedAt !== expectedUpdatedAt) return null;
    current = {
      ...current,
      resolutionSessionId: sessionId,
      status: 'in-progress',
      updatedAt: expectedUpdatedAt + 1,
    };
    return current;
  });
  const runtime = new ServerCoreIssueRuntime(base, {
    workspaceRoot: '/workspaces',
    privateRoots: ['/state'],
    metadata,
    issues: {
      get: (id) => id === current.id ? current : null,
      list: () => [current],
      listAppendices: () => [{
        id: 1,
        issueId: current.id,
        body: 'private=/state/provider-cache',
        logsRef: null,
        appendedSessionId: current.sourceSessionId,
        appendedAt: 3,
      }],
      update,
      linkResolutionSession,
      softDelete: (id) => {
        if (id !== current.id) return false;
        current = { ...current, deletedAt: 5, updatedAt: current.updatedAt + 1 };
        return true;
      },
      undelete: (id) => {
        if (id !== current.id) return false;
        current = { ...current, deletedAt: null, updatedAt: current.updatedAt + 1 };
        return true;
      },
    },
    sessionConsole: { createSession },
    rollbackSession,
  });
  return { createSession, linkResolutionSession, metadata, rollbackSession, runtime, update };
}

function resolutionParams(issueUpdatedAt = 2): JsonObject {
  return {
    issueId: 'issue-a',
    issueUpdatedAt,
    create: {
      adapterId: 'codex-cli',
      attachments: [],
      capabilityRevision: `sha256:${'a'.repeat(64)}`,
      initialMessage: 'Resolve the issue',
      options: sessionConsoleCreateOptionsFixture(),
      workingDirectory: 'repo',
    },
  };
}

describe('ServerCoreIssueRuntime', () => {
  it('adds the desktop Issue capability and projects Workspace/private paths', async () => {
    const { runtime } = harness();
    expect(runtime.supportedMethods).toContain('issues.list');
    const result = await runtime.execute(request('issues.get', { issueId: 'issue-a' }));
    expect(result.result).toMatchObject({
      issue: {
        cwd: 'repo',
        description: 'failed under Workspace/repo',
        appendices: [{ body: 'private=[private]/provider-cache' }],
      },
      revision: 4,
    });
  });

  it('uses expected revision and stable idempotency for Issue mutations', async () => {
    const { runtime, update } = harness();
    const input = request('issues.update', {
      issueId: 'issue-a',
      patch: { status: 'resolved' },
    }, { expectedRevision: 4, idempotencyKey: 'issue-intent-a' });
    const first = await runtime.execute(input);
    const replay = await runtime.execute({ ...input, requestId: 'request-replay' });
    expect(first).toEqual(replay);
    expect(first.result).toMatchObject({ issue: { status: 'resolved' }, revision: 5 });
    expect(update).toHaveBeenCalledOnce();
  });

  it('rejects stale mutations and grants Feishu the same Issue reads', async () => {
    const { runtime, update } = harness();
    await expect(runtime.execute(request('issues.update', {
      issueId: 'issue-a', patch: { status: 'resolved' },
    }, { expectedRevision: 3, idempotencyKey: 'stale' }))).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(update).not.toHaveBeenCalled();
    await expect(runtime.execute({
      ...request('issues.get', { issueId: 'issue-a' }),
      access: {
        ...desktop,
        transport: 'feishu',
        surface: 'feishu',
        grant: issueRemoteOwnerGrantClaim('feishu'),
      },
    } as DaemonRequestInput)).resolves.toMatchObject({ result: { issue: { id: 'issue-a' } } });
  });

  it('creates and links one idempotent resolution session inside the Core', async () => {
    const { createSession, linkResolutionSession, runtime } = harness();
    const input = request(
      'issues.resolve-in-new-session',
      resolutionParams(),
      { expectedRevision: 4, idempotencyKey: 'resolve-intent-a' },
    );
    const first = await runtime.execute(input);
    const replay = await runtime.execute({ ...input, requestId: 'resolve-replay' });
    expect(first).toEqual(replay);
    expect(first.result).toMatchObject({
      issue: { resolutionSessionId: 'session-resolution', status: 'in-progress' },
      revision: 5,
      sessionId: 'session-resolution',
    });
    expect(createSession).toHaveBeenCalledOnce();
    expect(linkResolutionSession).toHaveBeenCalledOnce();
  });

  it('strictly rolls back when the presented issue changes during create', async () => {
    const { metadata, rollbackSession, runtime } = harness({ updatedAt: 3 });
    await expect(runtime.execute(request(
      'issues.resolve-in-new-session',
      resolutionParams(2),
      { expectedRevision: 4, idempotencyKey: 'resolve-stale-issue' },
    ))).rejects.toMatchObject({ code: 'conflict' });
    expect(rollbackSession).toHaveBeenCalledWith('codex-cli', 'session-resolution');
    expect(metadata.ledger.has('resolve-stale-issue')).toBe(false);
  });

  it('releases deterministic repository failures so the same intent can retry', async () => {
    const { metadata, runtime } = harness();
    const input = request('issues.update', {
      issueId: 'missing-issue', patch: { status: 'resolved' },
    }, { expectedRevision: 4, idempotencyKey: 'missing-update' });

    await expect(runtime.execute(input)).rejects.toMatchObject({ code: 'not_found' });
    expect(metadata.ledger.has('missing-update')).toBe(false);
    await expect(runtime.execute({ ...input, requestId: 'missing-update-retry' }))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(metadata.ledger.has('missing-update')).toBe(false);
  });

  it('redacts secret-shaped Issue text before any Remote result is returned', async () => {
    const { runtime } = harness({
      description: 'token=sk-super-secret-value and /home/worker/.codex/auth.json',
    });
    const result = await runtime.execute(request('issues.get', { issueId: 'issue-a' }));
    const serialized = JSON.stringify(result.result);
    expect(serialized).not.toContain('sk-super-secret-value');
    expect(serialized).not.toContain('.codex/auth.json');
    expect(serialized).toContain('敏感内容已省略');
  });

  it('recovers an invoking parent intent after the Issue link committed', async () => {
    const { createSession, linkResolutionSession, metadata, runtime } = harness();
    const input = request(
      'issues.resolve-in-new-session',
      resolutionParams(),
      { expectedRevision: 4, idempotencyKey: 'resolve-recovery' },
    );
    metadata.failAppendOnce = true;
    await expect(runtime.execute(input)).rejects.toThrow('simulated change publication failure');
    await expect(runtime.execute({ ...input, requestId: 'resolve-recovery-retry' }))
      .resolves.toMatchObject({
        result: { sessionId: 'session-resolution', revision: 5 },
        revision: 5,
      });
    expect(linkResolutionSession).toHaveBeenCalledOnce();
    expect(createSession).toHaveBeenCalledTimes(2);
  });
});
