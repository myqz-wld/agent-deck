import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import {
  finalizeClaudeSessionStartCore,
  type ClaudeSessionFinalizeHost,
} from './session-finalize-core';

function hostWithTrace(trace: string[]): ClaudeSessionFinalizeHost {
  return {
    now: vi.fn().mockReturnValueOnce(101).mockReturnValueOnce(102),
    updateCliSessionId: vi.fn(() => trace.push('cli')),
    setSandbox: vi.fn(() => trace.push('sandbox')),
    setRuntimeProvider: vi.fn(() => trace.push('provider')),
    setAgentRuntimeProfile: vi.fn(() => trace.push('profile')),
    setModel: vi.fn(() => trace.push('model')),
    setThinking: vi.fn(() => trace.push('thinking')),
    setExtraAllowWrite: vi.fn(() => trace.push('extra')),
    publishPersistedSession: vi.fn(() => trace.push('publish')),
    warn: vi.fn(),
  };
}

describe('Claude session finalize Core', () => {
  it('registers, persists, publishes, and emits the first message in order', () => {
    const trace: string[] = [];
    const host = hostWithTrace(trace);
    const events: AgentEvent[] = [];
    const onRegistered = vi.fn(() => trace.push('registered'));

    finalizeClaudeSessionStartCore({
      applicationSid: 'application',
      cliSessionId: 'native',
      cwd: '/repo',
      prompt: 'continue',
      permissionMode: 'bypassPermissions',
      claudeSandboxMode: 'workspace-write',
      runtimeProvider: 'gateway-a',
      claudeAgentName: 'reviewer-claude',
      claudePluginDir: '/plugins/reviewer',
      claudeModel: 'claude-model',
      claudeCodeEffortLevel: 'xhigh',
      extraAllowWrite: ['/one', '/two'],
      attachments: [{ kind: 'uploaded', path: '/image.png', mime: 'image/png', bytes: 10 }],
      continuationMetadata: {
        formatVersion: 2,
        checkpointId: 7,
        sourceSessionId: 'source',
        sourceEventRevision: 42,
        preparationHash: 'hash',
        messageOrigin: 'continuation',
      },
      initialSessionRegistration: {
        spawnLink: { parentSessionId: 'lead', depth: 1 },
        hiddenFromHistory: true,
        onRegistered,
      },
      emit: (event) => {
        events.push(event);
        trace.push(`emit:${event.kind}`);
      },
    }, host);

    expect(trace).toEqual([
      'emit:session-start', 'registered', 'cli', 'sandbox', 'provider', 'profile',
      'model', 'thinking', 'extra', 'publish', 'emit:message',
    ]);
    expect(events.map((event) => event.ts)).toEqual([101, 102]);
    expect(events[0].payload).toMatchObject({
      cwd: '/repo',
      initialSpawnLink: { parentSessionId: 'lead', depth: 1 },
      initialHiddenFromHistory: true,
      initialRuntime: {
        permissionMode: 'bypassPermissions',
        claudeCodeSandbox: 'workspace-write',
        runtimeProvider: 'gateway-a',
        model: 'claude-model',
        thinking: 'xhigh',
      },
    });
    expect(events[1].payload).toMatchObject({
      text: 'continue',
      role: 'user',
      messageOrigin: 'continuation',
      continuation: { checkpointId: 7, sourceEventRevision: 42 },
    });
    expect(host.setAgentRuntimeProfile).toHaveBeenCalledWith('application', {
      agentProfileName: 'reviewer-claude',
      agentProfileSource: 'plugin',
      agentPluginDir: '/plugins/reviewer',
    });
    expect(host.setExtraAllowWrite).toHaveBeenCalledWith('application', ['/one', '/two']);
  });

  it('keeps optional persistence and both presentation events independently skippable', () => {
    const trace: string[] = [];
    const host = hostWithTrace(trace);
    const onRegistered = vi.fn();
    const emit = vi.fn();

    finalizeClaudeSessionStartCore({
      applicationSid: 'application',
      cwd: '/repo',
      prompt: 'hidden',
      claudeSandboxMode: 'off',
      extraAllowWrite: [],
      skipSessionStartEmit: true,
      skipFirstUserEmit: true,
      initialSessionRegistration: {
        spawnLink: { parentSessionId: 'lead', depth: 1 },
        onRegistered,
      },
      emit,
    }, host);

    expect(trace).toEqual(['sandbox', 'publish']);
    expect(emit).not.toHaveBeenCalled();
    expect(onRegistered).not.toHaveBeenCalled();
    expect(host.now).not.toHaveBeenCalled();
    expect(host.setExtraAllowWrite).not.toHaveBeenCalled();
  });

  it('does not let persistence or diagnostic failures suppress the first message', () => {
    const host = hostWithTrace([]);
    for (const key of [
      'updateCliSessionId', 'setSandbox', 'setRuntimeProvider', 'setAgentRuntimeProfile',
      'setModel', 'setThinking', 'setExtraAllowWrite', 'publishPersistedSession',
    ] as const) {
      vi.mocked(host[key]).mockImplementation(() => { throw new Error(`${key} failed`); });
    }
    vi.mocked(host.warn).mockImplementation(() => { throw new Error('diagnostic failed'); });
    const emit = vi.fn();

    expect(() => finalizeClaudeSessionStartCore({
      applicationSid: 'application',
      cliSessionId: 'native',
      cwd: '/repo',
      prompt: 'still visible',
      claudeSandboxMode: 'strict',
      runtimeProvider: 'gateway',
      claudeAgentName: 'agent',
      claudeModel: 'model',
      claudeCodeEffortLevel: 'max',
      extraAllowWrite: ['/write'],
      emit,
    }, host)).not.toThrow();

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'message' }));
  });
});
