import { describe, expect, it, vi } from 'vitest';

import {
  cleanupGatewaySandboxSettingsCore,
  prepareGatewaySandboxSettingsCore,
  type GatewaySandboxSettingsHost,
} from './gateway-sandbox-settings-core';

function host(overrides: Partial<GatewaySandboxSettingsHost> = {}): GatewaySandboxSettingsHost {
  return {
    readSettingsText: vi.fn(() => '{}'),
    materializeDerivedSettings: vi.fn(() => ({
      settingsPath: '/private/settings.json',
      cleanup: vi.fn(),
    })),
    ...overrides,
  };
}

describe('prepareGatewaySandboxSettingsCore', () => {
  it('passes through settings when no top-level sandbox needs materialization', () => {
    const gatewayHost = host();
    const sandboxOpts = {};

    expect(prepareGatewaySandboxSettingsCore({
      settingsPath: '/gateway.json',
      sandboxOpts,
    }, gatewayHost)).toEqual({
      settingsPath: '/gateway.json',
      sandboxOpts,
      childEnv: {},
      settingsBackedSandbox: false,
      cleanup: undefined,
    });
    expect(gatewayHost.readSettingsText).not.toHaveBeenCalled();
    expect(gatewayHost.materializeDerivedSettings).not.toHaveBeenCalled();
  });

  it('extracts string env and materializes non-env settings plus sandbox policy', () => {
    const remove = vi.fn();
    let serialized = '';
    const gatewayHost = host({
      readSettingsText: vi.fn(() => JSON.stringify({
        env: { TOKEN: 'secret', EMPTY: '', IGNORED: 42 },
        permissions: { deny: ['Read(.secret)'] },
      })),
      materializeDerivedSettings: vi.fn((value) => {
        serialized = value;
        return { settingsPath: '/private/settings.json', cleanup: remove };
      }),
    });
    const sandbox = { enabled: true, failIfUnavailable: true };

    const prepared = prepareGatewaySandboxSettingsCore({
      settingsPath: '/gateway.json',
      sandboxOpts: { sandbox },
    }, gatewayHost);

    expect(prepared.settingsPath).toBe('/private/settings.json');
    expect(prepared.sandboxOpts).toEqual({});
    expect(prepared.childEnv).toEqual({ TOKEN: 'secret', EMPTY: '' });
    expect(prepared.settingsBackedSandbox).toBe(true);
    expect(JSON.parse(serialized)).toEqual({
      permissions: { deny: ['Read(.secret)'] },
      sandbox,
    });
    prepared.cleanup?.();
    prepared.cleanup?.();
    expect(remove).toHaveBeenCalledOnce();
  });

  it.each(['null', '[]', '"settings"'])('rejects non-object settings before materialization: %s', (value) => {
    const gatewayHost = host({ readSettingsText: vi.fn(() => value) });

    expect(() => prepareGatewaySandboxSettingsCore({
      settingsPath: '/gateway.json',
      sandboxOpts: { sandbox: { enabled: true } },
    }, gatewayHost)).toThrow('Claude Gateway settings must contain a JSON object');
    expect(gatewayHost.materializeDerivedSettings).not.toHaveBeenCalled();
  });
});

describe('cleanupGatewaySandboxSettingsCore', () => {
  it('detaches cleanup before invoking it and never invokes it twice', () => {
    const cleanup = vi.fn(() => {
      throw new Error('cleanup failed');
    });
    const holder = { gatewaySandboxSettingsCleanup: cleanup };

    expect(() => cleanupGatewaySandboxSettingsCore(holder)).toThrow('cleanup failed');
    expect(holder.gatewaySandboxSettingsCleanup).toBeUndefined();
    expect(() => cleanupGatewaySandboxSettingsCore(holder)).not.toThrow();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
