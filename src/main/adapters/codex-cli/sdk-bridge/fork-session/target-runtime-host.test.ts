import { describe, expect, it, vi } from 'vitest';
import type { CreateSessionOpts } from '../create-session/_deps';

const mocks = vi.hoisted(() => ({
  getAgentsMd: vi.fn(() => 'application instructions'),
  getSetting: vi.fn(() => 'read-only'),
  resolveGatewayProfile: vi.fn(() => null),
}));

vi.mock('@main/codex-config/agents-md-installer', () => ({
  getAgentDeckCodexDeveloperInstructions: mocks.getAgentsMd,
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: { get: mocks.getSetting },
}));
vi.mock('@main/codex-config/gateway-profiles', () => ({
  resolveCodexGatewayProfile: mocks.resolveGatewayProfile,
}));

describe('desktop Codex fork target runtime host', () => {
  it('supplies the current sandbox and application instructions', async () => {
    const { resolveDesktopCodexForkTargetRuntime } = await import('./target-runtime-host');
    const runtime = resolveDesktopCodexForkTargetRuntime({
      prompt: 'delegate',
      cwd: '/repo',
      model: 'gpt-explicit',
      modelReasoningEffort: 'high',
      developerInstructions: 'delegated instructions',
    } as CreateSessionOpts);

    expect(mocks.getSetting).toHaveBeenCalledWith('codexSandbox');
    expect(mocks.getAgentsMd).toHaveBeenCalledOnce();
    expect(mocks.resolveGatewayProfile).toHaveBeenCalledWith(undefined);
    expect(runtime).toMatchObject({
      sandboxMode: 'read-only',
      persistedModel: 'gpt-explicit',
      effectiveDeveloperInstructions:
        'application instructions\n\n---\n\ndelegated instructions',
    });
  });
});
