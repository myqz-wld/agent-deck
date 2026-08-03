import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
}));
const settingsGet = vi.hoisted(() =>
  vi.fn((key: string) => state.settings[key]),
);
const resolveGateway = vi.hoisted(() =>
  vi.fn((provider: string | null | undefined) =>
    provider === 'deepseek'
      ? {
          id: 'deepseek',
          settingsPath: '/home/test/.claude/gateways/deepseek.json',
          modelAliases: { sonnet: 'deepseek-sonnet-test' },
          defaultModel: 'deepseek-default',
        }
      : null,
  ),
);
const capacityResolve = vi.hoisted(() =>
  vi.fn((identity: { status: string; identity?: unknown; reason?: string }): any =>
    identity.status === 'concrete'
      ? { status: 'unknown', identity: identity.identity, windowTokens: null, reason: 'no-observation' }
      : { status: 'unknown', identity: null, windowTokens: null, reason: identity.reason },
  ),
);

vi.mock('@main/store/settings-store', () => ({
  settingsStore: { get: settingsGet },
}));
vi.mock('@main/adapters/claude-code/gateway-profiles', () => ({
  resolveClaudeGatewayProfile: resolveGateway,
}));
vi.mock('@main/session/context-window/service', () => ({
  getContextWindowCapacityService: () => ({ resolve: capacityResolve, observe: vi.fn() }),
}));

import {
  resolveContinuationGeneratorConfigFingerprint,
  resolveContinuationGeneratorSnapshot,
  resolveContinuationRuntimeIdentity,
  resolveContinuationTargetSnapshot,
} from '../resolver';
import { createContextRuntimeIdentity } from '../../context-window/identity';
import {
  observedContextCapacity,
  staleContextCapacity,
  unknownContextCapacity,
} from './capacity-fixtures';

beforeEach(() => {
  state.settings = {
    continuationCheckpointAdapter: 'claude-code',
    continuationCheckpointRuntimeProvider: '',
    continuationCheckpointModel: '',
    continuationCheckpointThinking: 'high',
  };
  settingsGet.mockClear();
  resolveGateway.mockClear();
  capacityResolve.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('continuation generator defaults', () => {
  it('uses Claude Sonnet for a blank model and ignores the generic Anthropic model', () => {
    vi.stubEnv('ANTHROPIC_DEFAULT_SONNET_MODEL', '');
    vi.stubEnv('ANTHROPIC_MODEL', 'hidden-generic-model');
    state.settings.continuationCheckpointThinking = 'invalid';

    expect(resolveContinuationGeneratorSnapshot()).toMatchObject({
      adapter: 'claude-code',
      model: 'sonnet',
      thinking: 'medium',
    });
  });

  it('honors the Claude Sonnet alias override and trims an explicit model', () => {
    vi.stubEnv('ANTHROPIC_DEFAULT_SONNET_MODEL', ' claude-sonnet-env ');
    expect(resolveContinuationGeneratorSnapshot().model).toBe('claude-sonnet-env');

    state.settings.continuationCheckpointModel = ' claude-sonnet-explicit ';
    expect(resolveContinuationGeneratorSnapshot().model).toBe('claude-sonnet-explicit');
  });

  it('leaves a blank Codex model unset', () => {
    state.settings = {
      continuationCheckpointAdapter: 'codex-cli',
      continuationCheckpointRuntimeProvider: 'openai',
      continuationCheckpointModel: '   ',
      continuationCheckpointThinking: '',
    };

    expect(resolveContinuationGeneratorSnapshot()).toMatchObject({
      adapter: 'codex-cli',
      model: null,
      thinking: 'medium',
    });
  });

  it('uses the selected Claude Gateway Sonnet alias and a provider-valid effort', () => {
    state.settings = {
      continuationCheckpointAdapter: 'claude-code',
      continuationCheckpointRuntimeProvider: 'deepseek',
      continuationCheckpointModel: '',
      continuationCheckpointThinking: 'medium',
    };

    expect(resolveContinuationGeneratorSnapshot()).toMatchObject({
      adapter: 'claude-code',
      provider: 'deepseek',
      model: 'deepseek-sonnet-test',
      thinking: 'medium',
    });
    expect(resolveGateway).toHaveBeenCalledWith('deepseek');
  });

  it('maps Grok to its adapter while leaving a blank model to config.toml', () => {
    state.settings = {
      continuationCheckpointAdapter: 'grok-build',
      continuationCheckpointRuntimeProvider: '',
      continuationCheckpointModel: '   ',
      continuationCheckpointThinking: 'xhigh',
    };

    expect(resolveContinuationGeneratorSnapshot()).toMatchObject({
      adapter: 'grok-build',
      model: null,
      thinking: 'xhigh',
    });
  });

  it.each([
    ['stale', staleContextCapacity()],
    ['unknown', unknownContextCapacity()],
  ] as const)('freezes a tagged %s generator capacity snapshot', (_status, capacity) => {
    state.settings.continuationCheckpointModel = 'claude-sonnet-4-8';
    capacityResolve.mockReturnValueOnce(capacity);

    expect(resolveContinuationGeneratorSnapshot().contextCapacity).toEqual(capacity);
  });

  it('keeps generator configuration freshness independent from capacity resolution', () => {
    const before = resolveContinuationGeneratorConfigFingerprint();
    expect(capacityResolve).not.toHaveBeenCalled();

    capacityResolve.mockReturnValueOnce(observedContextCapacity(200_000));
    const first = resolveContinuationGeneratorSnapshot();
    capacityResolve.mockReturnValueOnce(observedContextCapacity(64_000));
    const second = resolveContinuationGeneratorSnapshot();

    expect(first.configFingerprint).toBe(before);
    expect(second.configFingerprint).toBe(before);
    expect(first.contextCapacity).not.toEqual(second.contextCapacity);
  });

  it('excludes a frozen target capacity from its configuration fingerprint', () => {
    const input = {
      adapter: 'codex-cli' as const,
      cwd: '/repo',
      provider: 'openai',
      model: 'gpt-5.6-sol',
      thinking: 'high',
      permissionMode: null,
      sandbox: { kind: 'codex', mode: 'read-only' },
      networkAccessEnabled: false,
      additionalDirectories: [] as string[],
    };
    capacityResolve.mockReturnValueOnce(observedContextCapacity(200_000));
    const first = resolveContinuationTargetSnapshot(input);
    capacityResolve.mockReturnValueOnce(observedContextCapacity(64_000));
    const second = resolveContinuationTargetSnapshot(input);

    expect(first.runtimeFingerprint).toBe(second.runtimeFingerprint);
    expect(first.contextCapacity).not.toEqual(second.contextCapacity);
  });
});

describe('continuation runtime identity equivalence', () => {
  it('reuses trusted Codex evidence only when the target rebuilds the same capacity config', () => {
    const trusted = createContextRuntimeIdentity({
      adapter: 'codex-cli',
      runtimeProvider: 'openai',
      model: 'gpt-effective',
      capacityConfigFingerprint: 'model-context-window:272000',
    });

    expect(resolveContinuationRuntimeIdentity({
      adapter: 'codex-cli',
      provider: 'openai',
      model: 'gpt-configured',
      capacityConfigFingerprint: 'model-context-window:272000',
      trustedRuntimeIdentity: trusted,
    })).toEqual({ status: 'concrete', identity: trusted });

    expect(resolveContinuationRuntimeIdentity({
      adapter: 'codex-cli',
      provider: 'openai',
      model: 'gpt-configured',
      trustedRuntimeIdentity: trusted,
    })).toMatchObject({
      status: 'concrete',
      identity: {
        model: 'gpt-configured',
        capacityConfigFingerprint: 'default',
      },
    });
  });
});
