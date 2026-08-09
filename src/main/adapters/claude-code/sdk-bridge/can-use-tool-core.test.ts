import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentEvent } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionMode } from '@main/adapters/types';
import {
  makeCanUseToolCore,
  type ClaudeCanUseToolHost,
  type MakeCanUseToolDeps,
} from './can-use-tool-core';
import type { PermissionResponderCore } from './permission-responder-core';
import { makeInternalSession, type InternalSession } from './types';

function makeInternal(permissionMode: PermissionMode): InternalSession {
  const internal = makeInternalSession({
    cwd: '/tmp/can-use-tool-core',
    permissionMode,
    applicationSid: 'session-core',
  });
  internal.cliSessionId = 'session-core';
  internal.query = undefined as unknown as Query;
  return internal;
}

function makeFixture(permissionMode: PermissionMode = 'default'): {
  deps: MakeCanUseToolDeps;
  emitted: AgentEvent[];
  host: ClaudeCanUseToolHost;
  internal: InternalSession;
  observeSandboxIntercept: ReturnType<typeof vi.fn>;
} {
  const internal = makeInternal(permissionMode);
  const emitted: AgentEvent[] = [];
  const observeSandboxIntercept = vi.fn();
  return {
    internal,
    emitted,
    observeSandboxIntercept,
    deps: {
      internal,
      getSessionId: () => internal.cliSessionId ?? 'temporary',
      getPermissionMode: () => internal.permissionMode,
      emit: (event) => emitted.push(event),
      getPermissionTimeoutMs: () => 0,
      responder: {} as PermissionResponderCore,
    },
    host: {
      createRequestId: () => 'request-core-1',
      now: () => 4242,
      observeSandboxIntercept,
    },
  };
}

function makeContext(): Parameters<ReturnType<typeof makeCanUseToolCore>>[2] {
  return {
    signal: new AbortController().signal,
    suggestions: undefined,
  } as Parameters<ReturnType<typeof makeCanUseToolCore>>[2];
}

describe('Claude can-use-tool Core', () => {
  it('owns deterministic permission request identity, event time, and pending state', async () => {
    const fixture = makeFixture();
    const canUseTool = makeCanUseToolCore(fixture.deps, fixture.host);

    void canUseTool('Write', { file_path: '/tmp/result' }, makeContext());
    await Promise.resolve();

    expect(fixture.emitted).toEqual([
      expect.objectContaining({
        sessionId: 'session-core',
        kind: 'waiting-for-user',
        ts: 4242,
        payload: expect.objectContaining({
          type: 'permission-request',
          requestId: 'request-core-1',
          toolName: 'Write',
        }),
      }),
    ]);
    expect(fixture.internal.pendingPermissions.has('request-core-1')).toBe(true);
  });

  it('keeps sandbox interception diagnostics best-effort', async () => {
    const fixture = makeFixture('bypassPermissions');
    fixture.observeSandboxIntercept.mockImplementation(() => {
      throw new Error('diagnostic sink failed');
    });
    const canUseTool = makeCanUseToolCore(fixture.deps, fixture.host);

    const result = await canUseTool(
      'SandboxNetworkAccess',
      { host: 'example.test' },
      makeContext(),
    );

    expect(fixture.observeSandboxIntercept).toHaveBeenCalledWith('example.test');
    expect(result).toEqual(expect.objectContaining({
      behavior: 'deny',
      interrupt: false,
      message: expect.stringContaining('example.test'),
    }));
  });
});
