import { describe, expect, it, vi } from 'vitest';

import type { AuthenticatedClientAccessContext, CoreMethod, JsonObject } from '@contracts/index';
import type { DaemonCoreRuntime, DaemonRequestInput } from '@hosts/daemon';
import type { AgentDeckMessageRepo } from '@main/store/agent-deck-message-repo';
import type { AgentDeckMessage, SessionRecord } from '@shared/types';
import { ServerCoreSessionMetadataRuntime } from './session-metadata-runtime';

const access: AuthenticatedClientAccessContext = {
  kind: 'authenticated-client', topology: 'server-core', instanceId: 'instance-a',
  clientId: 'desktop-a', transport: 'ssh', accessCredentialId: 'credential-a',
  authority: 'owner-equivalent', surface: 'desktop-full',
};

function input(method: CoreMethod, params: JsonObject): DaemonRequestInput {
  return {
    access, requestId: method, method, params, idempotencyKey: null,
    expectedRevision: null, deadlineAt: null, signal: new AbortController().signal,
  };
}

function session(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id, agentId: 'codex-cli', cwd: `/workspaces/${id}`, title: id, source: 'sdk',
    lifecycle: 'active', activity: 'idle', startedAt: 1, lastEventAt: 2,
    endedAt: null, archivedAt: null, pinnedAt: null, ...overrides,
  } as SessionRecord;
}

const message: AgentDeckMessage = {
  id: 'message-a', teamId: null, fromSessionId: 'session-a', toSessionId: 'session-b',
  body: 'token=sk-secretmarker123; inspect .codex/auth.json', status: 'failed',
  statusReason: 'Bearer abcdefghijklmnop', sentAt: 3, deliveredAt: null,
  attemptCount: 1, lastAttemptAt: 3, deliveringSince: null, deliveryGeneration: 0,
  deliveryLeaseToSessionId: null, replyToMessageId: null,
};

function harness(sessionOverrides: Partial<SessionRecord> = {}) {
  const rows = new Map([
    ['session-a', session('session-a', {
      codexApprovalPolicy: 'never', codexSandbox: 'workspace-write', networkAccessEnabled: false,
      ...sessionOverrides,
    })],
    ['session-b', session('session-b', { title: 'B sk-titlemarker123' })],
  ]);
  const base: DaemonCoreRuntime = {
    supportedMethods: ['system.health'],
    start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
    currentRevision: () => 7,
    execute: vi.fn(async () => ({ result: { ok: true }, revision: 7 })),
  };
  return new ServerCoreSessionMetadataRuntime(base, {
    sessions: { get: (id) => rows.get(id) ?? null },
    messages: { listBySession: () => [message] } as Pick<AgentDeckMessageRepo, 'listBySession'>,
    currentRevision: () => 7,
  });
}

describe('ServerCoreSessionMetadataRuntime', () => {
  it('projects effective permissions only from the durable session record', async () => {
    const response = await harness().execute(input('session.permissions.get', {
      sessionId: 'session-a',
    }));
    expect(response.result).toEqual({
      sessionId: 'session-a', adapterId: 'codex-cli',
      effective: {
        adapterId: 'codex-cli', approvalPolicy: 'never', approvalPolicySource: 'session',
        sandbox: 'workspace-write', sandboxSource: 'session',
      },
      workspace: { read: 'allowed', write: 'allowed', network: 'denied' },
      rules: { state: 'unavailable', items: [], omittedCount: 0, truncated: false },
      revision: 7,
    });
  });

  it.each([
    [true, 'allowed'],
    [false, 'denied'],
    [null, 'provider-default'],
  ] as const)('projects the persisted Codex network decision %s', async (value, network) => {
    const response = await harness({ networkAccessEnabled: value }).execute(input('session.permissions.get', {
      sessionId: 'session-a',
    }));
    expect(response.result).toMatchObject({ workspace: { network } });
  });

  it.each([
    ['workspace-write', 'allowed'],
    ['strict', 'denied'],
    ['off', 'provider-default'],
  ] as const)('projects Claude %s workspace write authority as %s', async (sandbox, write) => {
    const response = await harness({
      agentId: 'claude-code',
      permissionMode: 'default',
      claudeCodeSandbox: sandbox,
    }).execute(input('session.permissions.get', { sessionId: 'session-a' }));
    expect(response.result).toMatchObject({
      adapterId: 'claude-code',
      workspace: {
        read: sandbox === 'off' ? 'provider-default' : 'allowed',
        write,
        network: sandbox === 'off' ? 'provider-default' : 'denied',
      },
    });
  });

  it('returns a bounded redacted Cross-session projection', async () => {
    const response = await harness().execute(input('session.messages.list', {
      sessionId: 'session-a', limit: 100,
    }));
    const serialized = JSON.stringify(response.result);
    expect(serialized).not.toContain('secretmarker');
    expect(serialized).not.toContain('titlemarker');
    expect(serialized).not.toContain('.codex');
    expect(serialized).not.toContain('abcdefghijklmnop');
    expect(response.result).toMatchObject({
      sessionId: 'session-a', truncated: false,
      messages: [{ fromTitle: 'session-a', toTitle: 'B [敏感内容已省略]' }],
    });
  });
});
