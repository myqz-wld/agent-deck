import { describe, expect, it } from 'vitest';
import { buildSpawnPromptContext } from '../tools/handlers/spawn-prompt';
import { buildSpawnTargetOptions } from '../tools/handlers/spawn-target-options';

function input() {
  return {
    args: {
      adapter: 'codex-cli' as const,
      cwd: '/repo',
      prompt: 'Review this plan',
    },
    caller: {
      callerSessionId: 'source-session',
      transport: 'in-process' as const,
    },
    callerExists: true,
    leadRecord: { agentId: 'codex-cli', title: 'Source' },
    leadDisplayName: 'Source',
    promptToUse: 'Review this plan',
    teamIdEarly: null,
  };
}

describe('buildSpawnPromptContext', () => {
  it('keeps normal public spawn reply-anchor injection', () => {
    const result = buildSpawnPromptContext(input());
    expect(result.shouldWriteNormalSpawnLink).toBe(true);
    expect(result.willInjectWirePrefix).toBe(true);
    expect(result.placeholderId).toBeTruthy();
    expect(result.promptForSpawn).toContain('[msg ');
    expect(result.promptForSpawn).toContain('Review this plan');
  });

  it('keeps lineage but suppresses lead context for an internal review fork', () => {
    const result = buildSpawnPromptContext({
      ...input(),
      suppressLeadContext: true,
    });
    expect(result.shouldWriteNormalSpawnLink).toBe(true);
    expect(result.willInjectWirePrefix).toBe(false);
    expect(result.placeholderId).toBeNull();
    expect(result.promptForSpawn).toBe('Review this plan');
  });
});

describe('buildSpawnTargetOptions internal Codex access', () => {
  function target(codexRuntimeAccess?: {
    networkAccessEnabled?: boolean;
    additionalDirectories?: readonly string[];
  }) {
    return buildSpawnTargetOptions({
      args: input().args,
      prompt: 'Review this plan',
      effectivePermissionMode: undefined,
      effectiveCodexSandbox: 'danger-full-access',
      effectiveClaudeCodeSandbox: undefined,
      effectiveExtraAllowWrite: undefined,
      modelOptions: {},
      developerInstructions: undefined,
      codexConfigOverrides: undefined,
      claudeAgentName: undefined,
      claudeAgents: undefined,
      codexRuntimeAccess,
    });
  }

  it('preserves trusted same-adapter network and directory settings', () => {
    expect(target({
      networkAccessEnabled: false,
      additionalDirectories: ['/tmp', '/shared'],
    })).toMatchObject({
      agentId: 'codex-cli',
      networkAccessEnabled: false,
      additionalDirectories: ['/tmp', '/shared'],
    });
  });

  it('does not add those fields to an ordinary public spawn', () => {
    const options = target();
    expect('networkAccessEnabled' in options).toBe(false);
    expect('additionalDirectories' in options).toBe(false);
  });
});
