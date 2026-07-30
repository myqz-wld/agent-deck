import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupGatewaySandboxSettings,
  prepareGatewaySandboxSettings,
} from '../create-session/gateway-sandbox-settings';

const testRoots: string[] = [];

afterEach(() => {
  for (const root of testRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function gatewaySettingsPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-deck-gateway-sandbox-test-'));
  testRoots.push(root);
  const path = join(root, 'deepseek.json');
  writeFileSync(
    path,
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'test-secret',
        ANTHROPIC_BASE_URL: 'https://example.invalid',
        IGNORED_NON_STRING: 42,
      },
      permissions: { deny: ['Read(.secret)'] },
    }),
    'utf8',
  );
  return path;
}

describe('prepareGatewaySandboxSettings', () => {
  it('keeps the native settings path when no top-level sandbox is requested', () => {
    const settingsPath = gatewaySettingsPath();
    const prepared = prepareGatewaySandboxSettings({
      settingsPath,
      sandboxOpts: {},
    });

    expect(prepared).toEqual({
      settingsPath,
      sandboxOpts: {},
      childEnv: {},
      settingsBackedSandbox: false,
      cleanup: undefined,
    });
  });

  it('moves Gateway env to the child and writes a private settings-backed sandbox', () => {
    const settingsPath = gatewaySettingsPath();
    const sandbox = {
      enabled: true,
      failIfUnavailable: false,
      filesystem: { allowWrite: ['/repo'] },
    };
    const prepared = prepareGatewaySandboxSettings({
      settingsPath,
      sandboxOpts: { sandbox },
    });

    expect(prepared.settingsPath).not.toBe(settingsPath);
    expect(prepared.sandboxOpts).toEqual({});
    expect(prepared.settingsBackedSandbox).toBe(true);
    expect(prepared.childEnv).toEqual({
      ANTHROPIC_AUTH_TOKEN: 'test-secret',
      ANTHROPIC_BASE_URL: 'https://example.invalid',
    });

    const derivedPath = prepared.settingsPath as string;
    expect(statSync(derivedPath).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(derivedPath)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(derivedPath, 'utf8'))).toEqual({
      permissions: { deny: ['Read(.secret)'] },
      sandbox,
    });
    expect(readFileSync(settingsPath, 'utf8')).toContain('ANTHROPIC_AUTH_TOKEN');

    const holder = {
      gatewaySandboxSettingsCleanup: prepared.cleanup,
    };
    cleanupGatewaySandboxSettings(holder);
    cleanupGatewaySandboxSettings(holder);
    expect(holder.gatewaySandboxSettingsCleanup).toBeUndefined();
    expect(existsSync(derivedPath)).toBe(false);
  });
});
