import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { respondToServerCorePending } from '@hosts/server-core/runtime-pending';
import type { AgentAdapter } from '@main/adapters/types';
import type { AgentEvent, PermissionResponse } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import { PermissionResponderCore, type ClaudePermissionResponderHost } from './permission-responder-core';
import { makeInternalSession, type InternalSession } from './types';

function makeInternal(): InternalSession {
  const internal = makeInternalSession({
    cwd: '/tmp/permission-responder-core',
    permissionMode: 'plan',
    applicationSid: 'session-core',
  });
  internal.cliSessionId = 'session-core';
  return internal;
}

function makeHost(overrides: Partial<ClaudePermissionResponderHost> = {}): {
  host: ClaudePermissionResponderHost;
  persistPermissionMode: ReturnType<typeof vi.fn>;
  observeHotSwitchFailure: ReturnType<typeof vi.fn>;
} {
  const persistPermissionMode = vi.fn();
  const observeHotSwitchFailure = vi.fn();
  return {
    persistPermissionMode,
    observeHotSwitchFailure,
    host: {
      persistPermissionMode,
      observeHotSwitchFailure,
      observeColdSwitchFailure: vi.fn(),
      now: () => 7000,
      ...overrides,
    },
  };
}

describe('Claude permission responder Core', () => {
  function permissionFixture() {
    const internal = makeInternal();
    const resolver = vi.fn();
    const toolInput = { file_path: '/workspace/app.txt', old_string: 'before', new_string: 'after' };
    internal.pendingPermissions.set('edit', {
      payload: { type: 'permission-request', requestId: 'edit', toolName: 'Edit', toolInput },
      resolver,
      timer: null,
    });
    const responder = new PermissionResponderCore({
      sessions: new Map([['session-core', internal]]), emit: vi.fn(), getPermissionTimeoutMs: () => 0,
    }, vi.fn(), makeHost().host);
    return { responder, internal, resolver, toolInput };
  }

  it('preserves the approved Edit arguments through the Server Core pending handler', async () => {
    const { responder, internal, resolver, toolInput } = permissionFixture();
    const adapter = {
      listPending: (sid: string) => responder.listPending(sid),
      respondPermission: async (sid: string, id: string, response: PermissionResponse) =>
        responder.respondPermission(sid, id, response),
    } as AgentAdapter;
    await expect(respondToServerCorePending(adapter, {
      sessionId: 'session-core', requestId: 'edit', action: 'approve',
    }, { respond: () => null })).resolves.toBe('resolved');
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({
      behavior: 'allow', updatedInput: toolInput,
    }));
    expect(internal.pendingPermissions.size).toBe(0);
    expect(internal.permissionMode).toBe('plan');
  });

  it.each([{ new_string: 'override' }, {}])('honors an explicit input override: %j', (updatedInput) => {
    const { responder, resolver } = permissionFixture();
    responder.respondPermission('session-core', 'edit', { decision: 'allow', updatedInput });
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'allow', updatedInput }));
    responder.respondPermission('session-core', 'edit', { decision: 'deny' });
    expect(resolver).toHaveBeenCalledOnce();
  });

  it('keeps denial separate from input and permission overrides', () => {
    const { responder, resolver, internal } = permissionFixture();
    responder.respondPermission('session-core', 'edit', {
      decision: 'deny', message: 'declined', updatedInput: { new_string: 'ignored' },
    });
    expect(resolver).toHaveBeenCalledWith({ behavior: 'deny', message: 'declined', interrupt: false });
    expect(internal.permissionMode).toBe('plan');
  });

  it('rolls back a failed hot switch and keeps diagnostics best-effort', async () => {
    const internal = makeInternal();
    internal.query = {
      setPermissionMode: vi.fn(async () => {
        throw new Error('SDK mode failed');
      }),
    } as unknown as Query;
    internal.pendingExitPlanModes.set('exit-1', {
      payload: {
        type: 'exit-plan-mode',
        requestId: 'exit-1',
        toolUseId: 'tool-1',
        plan: 'ship it',
      },
      toolInput: { plan: 'ship it' },
      timer: null,
      resolver: vi.fn(),
    });
    const emitted: AgentEvent[] = [];
    const fixture = makeHost({
      observeHotSwitchFailure: () => {
        throw new Error('diagnostic failed');
      },
    });
    const responder = new PermissionResponderCore(
      {
        sessions: new Map([['session-core', internal]]),
        emit: (event) => emitted.push(event),
        getPermissionTimeoutMs: () => 30_000,
      },
      vi.fn(async () => 'session-core'),
      fixture.host,
    );

    await responder.respondExitPlanMode('session-core', 'exit-1', {
      decision: 'approve',
      targetMode: 'acceptEdits',
    });

    expect(internal.permissionMode).toBe('plan');
    expect(fixture.persistPermissionMode).not.toHaveBeenCalled();
    expect(emitted).toEqual([
      expect.objectContaining({
        sessionId: 'session-core',
        kind: 'message',
        ts: 7000,
        payload: expect.objectContaining({ error: true }),
      }),
    ]);
  });

  it('owns permission timeout cancellation, messaging, and resolution', () => {
    const internal = makeInternal();
    internal.query = undefined as unknown as Query;
    const resolver = vi.fn();
    internal.pendingPermissions.set('permission-1', {
      payload: {
        type: 'permission-request',
        requestId: 'permission-1',
        toolName: 'Write',
        toolInput: {},
      },
      timer: null,
      resolver,
    });
    const emitted: AgentEvent[] = [];
    const { host } = makeHost();
    const responder = new PermissionResponderCore(
      {
        sessions: new Map([['session-core', internal]]),
        emit: (event) => emitted.push(event),
        getPermissionTimeoutMs: () => 30_000,
      },
      vi.fn(async () => 'session-core'),
      host,
    );

    responder.timeoutPermission('session-core', 'permission-1');

    expect(internal.pendingPermissions.size).toBe(0);
    expect(resolver).toHaveBeenCalledWith({
      behavior: 'deny',
      message: 'timeout',
      interrupt: true,
    });
    expect(emitted).toHaveLength(2);
    expect(emitted.every((event) => event.ts === 7000)).toBe(true);
    expect(emitted[1]?.payload).toEqual(expect.objectContaining({
      text: expect.stringContaining('30 秒'),
      error: true,
    }));
  });
});
