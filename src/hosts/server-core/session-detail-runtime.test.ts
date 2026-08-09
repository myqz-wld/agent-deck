import { describe, expect, it, vi } from 'vitest';

import type {
  AuthenticatedClientAccessContext,
  CoreMethod,
  JsonObject,
} from '@contracts/index';
import type { DaemonCoreRuntime, DaemonRequestInput } from '@hosts/daemon';
import type { SessionRecord } from '@shared/types';
import { ServerCoreSessionDetailRuntime } from './session-detail-runtime';

const desktop: AuthenticatedClientAccessContext = {
  kind: 'authenticated-client',
  topology: 'server-core',
  instanceId: 'instance-a',
  clientId: 'desktop-a',
  transport: 'ssh',
  accessCredentialId: 'credential-a',
  authority: 'owner-equivalent',
  surface: 'desktop-full',
};

const session: SessionRecord = {
  id: 'session-a',
  agentId: 'codex-cli',
  cwd: '/workspaces/repo',
  title: 'Session',
  source: 'sdk',
  lifecycle: 'active',
  activity: 'idle',
  startedAt: 1,
  lastEventAt: 2,
  endedAt: null,
  archivedAt: null,
};

function request(
  method: CoreMethod,
  params: JsonObject,
  access: AuthenticatedClientAccessContext = desktop,
): DaemonRequestInput {
  return {
    access,
    requestId: `request-${method}`,
    method,
    params,
    idempotencyKey: null,
    expectedRevision: null,
    deadlineAt: null,
    signal: new AbortController().signal,
  };
}

function harness(overrides: {
  filePath?: string;
  fileKind?: string;
  beforeBlob?: string | null;
  afterBlob?: string | null;
} = {}) {
  const base: DaemonCoreRuntime = {
    supportedMethods: ['system.health'],
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    currentRevision: vi.fn(() => 12),
    execute: vi.fn(async () => ({ result: { ok: true, revision: 12 }, revision: 12 })),
  };
  const getFinalDiff = vi.fn(async (_sessionId: string, filePath: string) => ({
    ok: true as const,
    filePath,
    diff: [
      '--- /workspaces/repo/src/index.ts',
      '+++ /state/private/provider-home/output.ts',
      '--- /etc/core-secret',
      '+++ /opt/worker-private/output.ts',
      '+const route = "/api/v1";',
    ].join('\n'),
    source: 'recorded-snapshot' as const,
  }));
  const runtime = new ServerCoreSessionDetailRuntime(base, {
    workspaceRoot: '/workspaces',
    sessions: { get: (id) => id === session.id ? session : null },
    summaries: {
      listForSession: () => [{
        id: 1,
        sessionId: session.id,
        content: 'summary',
        trigger: 'time',
        ts: 2,
        sourceEventRevision: 1,
        sourceRebuildAfterRevision: 0,
        generationSource: 'llm',
      }],
    },
    events: {
      listValidForSession: () => [{
        id: 4,
        sessionId: session.id,
        agentId: '',
        kind: 'message',
        payload: { role: 'assistant', text: 'Workspace event', cwd: '/workspaces/repo' },
        ts: 4,
      }],
    },
    tasks: {
      listForSession: () => [{
        id: 'task-1',
        ownerSessionId: session.id,
        teamId: null,
        subject: 'Remote task',
        description: null,
        status: 'active',
        activeForm: 'Testing Remote tasks',
        priority: 5,
        blocks: [],
        blockedBy: [],
        labels: ['remote'],
        createdAt: '2026-08-07T00:00:00.000Z',
        updatedAt: '2026-08-07T00:01:00.000Z',
      }],
    },
    fileChanges: {
      listSummaryPage: () => ({
        items: [{
          id: 3,
          sessionId: session.id,
          filePath: overrides.filePath ?? '/workspaces/repo/src/index.ts',
          kind: overrides.fileKind ?? 'text',
          toolCallId: null,
          hasBeforeBlob: true,
          hasAfterBlob: true,
          hasBeforeSnapshot: false,
          hasAfterSnapshot: false,
          ts: 3,
        }],
        nextCursor: null,
      }),
      getPayload: () => ({
        id: 3,
        sessionId: session.id,
        filePath: overrides.filePath ?? '/workspaces/repo/src/index.ts',
        kind: overrides.fileKind ?? 'text',
        beforeBlob: overrides.beforeBlob === undefined ? 'before' : overrides.beforeBlob,
        afterBlob: overrides.afterBlob === undefined ? 'after' : overrides.afterBlob,
        metadata: {
          cwd: '/workspaces/repo',
          diff: '--- /workspaces/repo/src/index.ts\n+++ /opt/worker-private/output.ts',
          privatePath: '/state/private/provider-home',
          externalPath: '/etc/secret',
        },
        toolCallId: null,
        ts: 3,
      }),
    },
    getFinalDiff,
    privateRoots: ['/state/private'],
  });
  return { base, getFinalDiff, runtime };
}

describe('ServerCoreSessionDetailRuntime', () => {
  it('adds bounded detail capabilities and delegates lifecycle', async () => {
    const { base, runtime } = harness();
    expect(runtime.supportedMethods).toContain('session.summaries.list');
    expect(runtime.supportedMethods).toContain('session.file-changes.final-diff');
    expect(runtime.supportedMethods).toContain('session.tasks.list');
    expect(runtime.supportedMethods).toContain('session.events.list');
    await runtime.start();
    await runtime.stop('done');
    expect(base.start).toHaveBeenCalledOnce();
    expect(base.stop).toHaveBeenCalledWith('done');
  });

  it('returns bounded Workspace-projected event records', async () => {
    const { runtime } = harness();
    await expect(runtime.execute(request('session.events.list', {
      sessionId: session.id,
      limit: 20,
    }))).resolves.toMatchObject({
      result: {
        events: [{ id: 4, agentId: 'codex-cli', payload: { cwd: 'Workspace/repo' } }],
        revision: 12,
        truncated: false,
      },
    });
  });

  it('returns the exact session-visible task projection', async () => {
    const { runtime } = harness();
    await expect(runtime.execute(request('session.tasks.list', {
      sessionId: session.id,
      limit: 20,
    }))).resolves.toMatchObject({
      result: {
        tasks: [{ id: 'task-1', ownerSessionId: session.id, status: 'active' }],
        revision: 12,
      },
    });
  });

  it('projects file paths and metadata relative to Workspace', async () => {
    const { runtime } = harness();
    const page = await runtime.execute(request('session.file-changes.list', {
      sessionId: session.id,
      limit: 20,
    }));
    expect(page.result).toMatchObject({
      items: [{ filePath: 'repo/src/index.ts' }],
      revision: 12,
    });
    const payload = await runtime.execute(request('session.file-changes.get', {
      sessionId: session.id,
      changeId: 3,
    }));
    expect(payload.result).toMatchObject({
      change: {
        filePath: 'repo/src/index.ts',
        metadata: {
          cwd: 'Workspace/repo',
          diff: '--- Workspace/repo/src/index.ts\n+++ [outside Workspace]',
          privatePath: '[private]',
          externalPath: '[outside Workspace]',
        },
      },
    });
  });

  it('resolves final diff requests inside Workspace without returning the host path', async () => {
    const { getFinalDiff, runtime } = harness();
    const result = await runtime.execute(request('session.file-changes.final-diff', {
      sessionId: session.id,
      filePath: 'repo/src/index.ts',
    }));
    expect(getFinalDiff).toHaveBeenCalledWith(session.id, '/workspaces/repo/src/index.ts');
    expect(result.result).toMatchObject({
      fileDiff: {
        filePath: 'repo/src/index.ts',
        ok: true,
        diff: [
          '--- Workspace/repo/src/index.ts',
          '+++ [private]',
          '--- [outside Workspace]',
          '+++ [outside Workspace]',
          '+const route = "/api/v1";',
        ].join('\n'),
      },
      revision: 12,
    });
  });

  it('projects image rows to opaque asset handles without returning Worker paths', async () => {
    const { runtime } = harness({
      fileKind: 'image',
      beforeBlob: JSON.stringify({ kind: 'path', path: '/workspaces/repo/before.png' }),
      afterBlob: JSON.stringify({ kind: 'path', path: '/workspaces/repo/after.png' }),
    });
    await expect(runtime.execute(request('session.file-changes.list', {
      sessionId: session.id,
      limit: 20,
    }))).resolves.toMatchObject({ result: { items: [{ id: 3, kind: 'image' }] } });
    const payload = await runtime.execute(request('session.file-changes.get', {
      sessionId: session.id,
      changeId: 3,
    }));
    expect(payload.result).toMatchObject({
      change: {
        beforeBlob: JSON.stringify({ kind: 'remote-file-change', changeId: 3, side: 'before' }),
        afterBlob: JSON.stringify({ kind: 'remote-file-change', changeId: 3, side: 'after' }),
      },
    });
    expect(JSON.stringify(payload.result)).not.toContain('/workspaces');
  });

  it('fails closed for outside-Workspace rows and Feishu access', async () => {
    const outside = harness({ filePath: '/private/secret.txt' }).runtime;
    await expect(outside.execute(request('session.file-changes.list', {
      sessionId: session.id,
      limit: 20,
    }))).rejects.toMatchObject({ code: 'access_denied' });
    const feishu = { ...desktop, transport: 'feishu', surface: 'feishu-session-console' } as const;
    await expect(harness().runtime.execute(request('session.summaries.list', {
      sessionId: session.id,
      limit: 20,
    }, feishu))).rejects.toMatchObject({ code: 'access_denied' });
  });
});
