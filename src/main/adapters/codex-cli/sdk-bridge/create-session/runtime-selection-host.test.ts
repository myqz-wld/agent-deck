import { describe, expect, it, vi } from 'vitest';
import type { CreateSessionOpts } from './_deps';

const mocks = vi.hoisted(() => ({
  getInstructions: vi.fn(() => 'application'),
  getSession: vi.fn(),
  getSetting: vi.fn(() => 'read-only'),
  readReasoning: vi.fn(() => 'high'),
  resolveGatewayProfile: vi.fn(() => null),
}));

vi.mock('@main/codex-config/agents-md-installer', () => ({
  getAgentDeckCodexDeveloperInstructions: mocks.getInstructions,
}));
vi.mock('@main/codex-config/toml-writer', () => ({
  readTopLevelModelReasoningEffortFromCodexConfig: mocks.readReasoning,
}));
vi.mock('@main/codex-config/gateway-profiles', () => ({
  resolveCodexGatewayProfile: mocks.resolveGatewayProfile,
}));
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: { get: mocks.getSession },
}));
vi.mock('@main/store/settings-store', () => ({
  settingsStore: { get: mocks.getSetting },
}));

describe('desktop Codex live create runtime host', () => {
  it('supplies current repository, settings, native config, and application instructions', async () => {
    const {
      readDesktopCodexCreateResumeRecord,
      resolveDesktopCodexCreateRuntime,
    } = await import('./runtime-selection-host');
    const options = {
      cwd: '/repo',
      prompt: 'run',
    } as CreateSessionOpts;
    const record = readDesktopCodexCreateResumeRecord(options);
    const resolved = resolveDesktopCodexCreateRuntime(options, record);

    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.getSetting).toHaveBeenCalledWith('codexSandbox');
    expect(mocks.readReasoning).toHaveBeenCalledOnce();
    expect(mocks.getInstructions).toHaveBeenCalledOnce();
    expect(mocks.resolveGatewayProfile).toHaveBeenCalledWith(undefined);
    expect(resolved).toMatchObject({
      developerInstructions: 'application',
      sandboxMode: 'read-only',
    });
    expect(resolved.effectiveOpts.modelReasoningEffort).toBe('high');
  });
});
