import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ForkedSessionHandle } from '../../types';

const mocks = vi.hoisted(() => ({
  createFork: vi.fn(),
  deleteSession: vi.fn(async () => undefined),
}));

vi.mock('../fork-session-core', () => ({
  createClaudeFamilyForkedSessionCore: mocks.createFork,
}));

import {
  ClaudeCodeAdapter,
  type ClaudeCodeAdapterHost,
} from '../adapter-core';

describe('Claude adapter native fork wiring', () => {
  afterEach(() => {
    mocks.createFork.mockReset();
    mocks.deleteSession.mockClear();
  });

  it('resumes the distinct fork with every resolved target option', async () => {
    const bridge = {
      createSession: vi.fn(async () => ({ sessionId: 'child-app-id' })),
      closeSession: vi.fn(async () => undefined),
      closeSessionForRollback: vi.fn(async () => undefined),
    };
    const host = {
      bridge: {
        sessionManager: { delete: mocks.deleteSession },
      },
      fork: { name: 'fork-host' },
      createHookIntegration: vi.fn(),
      registerHookRoutes: vi.fn(),
      validateForkTarget: vi.fn(),
      summariseEvents: vi.fn(),
    } as unknown as ClaudeCodeAdapterHost;
    const adapter = new ClaudeCodeAdapter(host);
    (adapter as unknown as { bridge: typeof bridge }).bridge = bridge;
    const discard = vi.fn(async () => undefined);
    mocks.createFork.mockImplementationOnce(async (args) => {
      expect(args.deleteChild).toEqual(expect.any(Function));
      const childId = await args.createChild('fork-native-id');
      await args.closeChild(childId);
      await args.deleteChild(childId);
      expect(childId).toBe('child-app-id');
      return { sessionId: childId, discard } satisfies ForkedSessionHandle;
    });

    const source = {
      applicationSessionId: 'source-app-id',
      nativeSessionId: 'source-native-id',
      cwd: '/tmp/project',
    };
    const target = {
      agentId: 'claude-code' as const,
      cwd: '/tmp/project',
      prompt: 'delegated prompt',
      permissionMode: 'bypassPermissions' as const,
      teamName: 'fork-team',
      gateway: 'deepseek',
      model: 'claude-opus-4-8',
      claudeCodeEffortLevel: 'xhigh' as const,
      claudeAgentName: 'reviewer-claude',
      claudeAgents: { 'reviewer-claude': { description: 'review', prompt: 'review' } },
      claudeCodeSandbox: 'workspace-write' as const,
      extraAllowWrite: ['/tmp/shared'],
      awaitCanonicalId: true,
    };

    const result = await adapter.createForkedSession(source, target);

    expect(result).toEqual({ sessionId: 'child-app-id', discard });
    expect(mocks.createFork).toHaveBeenCalledWith(
      expect.objectContaining({ source, providerName: 'Claude' }),
      host.fork,
    );
    expect(mocks.deleteSession).toHaveBeenCalledWith('child-app-id');
    expect(bridge.createSession).toHaveBeenCalledWith({
      cwd: target.cwd,
      prompt: target.prompt,
      gateway: target.gateway,
      permissionMode: target.permissionMode,
      resume: 'fork-native-id',
      teamName: target.teamName,
      attachments: undefined,
      claudeCodeSandbox: target.claudeCodeSandbox,
      extraAllowWrite: target.extraAllowWrite,
      model: target.model,
      claudeCodeEffortLevel: target.claudeCodeEffortLevel,
      claudeAgentName: target.claudeAgentName,
      claudeAgents: target.claudeAgents,
      handOff: undefined,
      awaitCanonicalId: true,
    });
    expect(bridge.closeSessionForRollback).toHaveBeenCalledWith('child-app-id');
    expect(bridge.closeSession).not.toHaveBeenCalled();
  });
});
