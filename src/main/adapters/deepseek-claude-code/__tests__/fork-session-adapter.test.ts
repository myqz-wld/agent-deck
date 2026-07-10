import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ForkedSessionHandle } from '../../types';

const createForkMock = vi.hoisted(() => vi.fn());

vi.mock('../../claude-code/fork-session', () => ({
  createClaudeFamilyForkedSession: createForkMock,
  getClaudeConfigRoot: () => '/tmp/agent-deck-deepseek-main-root',
}));
vi.mock('../config', async () => {
  const actual = await vi.importActual<typeof import('../config')>('../config');
  return {
    ...actual,
    getDeepseekSettingsPath: () => '/tmp/agent-deck-deepseek-missing-settings.json',
  };
});

import { deepseekClaudeCodeAdapter } from '../index';

describe('Deepseek adapter native fork wiring', () => {
  afterEach(() => {
    createForkMock.mockReset();
    (deepseekClaudeCodeAdapter as unknown as { bridge: unknown }).bridge = null;
  });

  it('validates and resumes the fork with every resolved target option', async () => {
    const bridge = {
      createSession: vi.fn(async () => ({ sessionId: 'deepseek-child-app' })),
      closeSession: vi.fn(async () => undefined),
    };
    (deepseekClaudeCodeAdapter as unknown as { bridge: typeof bridge }).bridge = bridge;
    const discard = vi.fn(async () => undefined);
    createForkMock.mockImplementationOnce(async (args) => {
      expect(args.providerName).toBe('Deepseek');
      expect(args.deleteChild).toEqual(expect.any(Function));
      const childId = await args.createChild('deepseek-fork-native');
      return { sessionId: childId, discard } satisfies ForkedSessionHandle;
    });

    const source = {
      applicationSessionId: 'deepseek-source-app',
      nativeSessionId: 'deepseek-source-native',
      cwd: '/tmp/project',
    };
    const target = {
      agentId: 'deepseek-claude-code' as const,
      cwd: '/tmp/project',
      prompt: 'delegated prompt',
      permissionMode: 'bypassPermissions' as const,
      teamName: 'fork-team',
      model: 'deepseek-v4-pro[1m]',
      claudeCodeEffortLevel: 'xhigh' as const,
      claudeAgentName: 'reviewer-deepseek',
      claudeAgents: { 'reviewer-deepseek': { description: 'review', prompt: 'review' } },
      claudeCodeSandbox: 'workspace-write' as const,
      extraAllowWrite: ['/tmp/shared'],
      awaitCanonicalId: true,
    };

    await expect(deepseekClaudeCodeAdapter.validateForkSession(source, target)).resolves.toBeUndefined();
    const result = await deepseekClaudeCodeAdapter.createForkedSession(source, target);

    expect(result).toEqual({ sessionId: 'deepseek-child-app', discard });
    expect(bridge.createSession).toHaveBeenCalledWith({
      cwd: target.cwd,
      prompt: target.prompt,
      permissionMode: target.permissionMode,
      resume: 'deepseek-fork-native',
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
