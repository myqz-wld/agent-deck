import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import {
  PermissionResponderCore,
  type ClaudePermissionResponderHost,
} from './permission-responder-core';
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
