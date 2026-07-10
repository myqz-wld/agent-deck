import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ForkedSessionHandle } from '../../types';

const createForkMock = vi.hoisted(() => vi.fn());

vi.mock('../fork-session', () => ({
  createClaudeFamilyForkedSession: createForkMock,
}));

import { claudeCodeAdapter } from '../index';

describe('Claude adapter native fork wiring', () => {
  afterEach(() => {
    createForkMock.mockReset();
    (claudeCodeAdapter as unknown as { bridge: unknown }).bridge = null;
  });

  it('resumes the distinct fork with every resolved target option', async () => {
    const bridge = {
      createSession: vi.fn(async () => ({ sessionId: 'child-app-id' })),
      closeSession: vi.fn(async () => undefined),
    };
    (claudeCodeAdapter as unknown as { bridge: typeof bridge }).bridge = bridge;
    const discard = vi.fn(async () => undefined);
    createForkMock.mockImplementationOnce(async (args) => {
      expect(args.deleteChild).toEqual(expect.any(Function));
      const childId = await args.createChild('fork-native-id');
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
      model: 'claude-opus-4-8',
      claudeCodeEffortLevel: 'xhigh' as const,
      claudeAgentName: 'reviewer-claude',
      claudeAgents: { 'reviewer-claude': { description: 'review', prompt: 'review' } },
      claudeCodeSandbox: 'workspace-write' as const,
      extraAllowWrite: ['/tmp/shared'],
      awaitCanonicalId: true,
    };

    const result = await claudeCodeAdapter.createForkedSession(source, target);

    expect(result).toEqual({ sessionId: 'child-app-id', discard });
    expect(createForkMock).toHaveBeenCalledWith(
      expect.objectContaining({ source, providerName: 'Claude' }),
    );
    expect(bridge.createSession).toHaveBeenCalledWith({
      cwd: target.cwd,
      prompt: target.prompt,
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
  });
});
