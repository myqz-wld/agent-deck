import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { buildSandboxOptions } from '../../sandbox-config';

type SandboxOptions = ReturnType<typeof buildSandboxOptions>;

export interface PreparedGatewaySandboxSettings {
  settingsPath: string | undefined;
  sandboxOpts: SandboxOptions;
  childEnv: Record<string, string>;
  settingsBackedSandbox: boolean;
  cleanup: (() => void) | undefined;
}

export interface GatewaySandboxSettingsCleanupHolder {
  gatewaySandboxSettingsCleanup?: () => void;
}

function readSettingsObject(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Claude Gateway settings must contain a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function stringEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') env[key] = entry;
  }
  return env;
}

/**
 * Claude Agent SDK 0.3.220 rejects a settings file path together with top-level sandbox options.
 * Keep Gateway credentials isolated to this child process, while a private derived settings file
 * carries the non-env profile fields plus the per-session sandbox configuration.
 */
export function prepareGatewaySandboxSettings(input: {
  settingsPath?: string;
  sandboxOpts: SandboxOptions;
}): PreparedGatewaySandboxSettings {
  if (!input.settingsPath || !input.sandboxOpts.sandbox) {
    return {
      settingsPath: input.settingsPath,
      sandboxOpts: input.sandboxOpts,
      childEnv: {},
      settingsBackedSandbox: false,
      cleanup: undefined,
    };
  }

  const source = readSettingsObject(input.settingsPath);
  const childEnv = stringEnv(source.env);
  const { env: _gatewayEnv, ...settingsWithoutEnv } = source;
  const derivedSettings = {
    ...settingsWithoutEnv,
    sandbox: input.sandboxOpts.sandbox,
  };

  const temporaryDir = mkdtempSync(
    join(tmpdir(), 'agent-deck-claude-gateway-settings-'),
  );
  try {
    chmodSync(temporaryDir, 0o700);
    const derivedPath = join(temporaryDir, 'settings.json');
    writeFileSync(derivedPath, JSON.stringify(derivedSettings), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    let cleaned = false;
    return {
      settingsPath: derivedPath,
      sandboxOpts: {},
      childEnv,
      settingsBackedSandbox: true,
      cleanup: () => {
        if (cleaned) return;
        cleaned = true;
        try {
          rmSync(temporaryDir, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup must not alter provider/session lifecycle.
        }
      },
    };
  } catch (error) {
    try {
      rmSync(temporaryDir, { recursive: true, force: true });
    } catch {
      // Preserve the preparation error.
    }
    throw error;
  }
}

export function cleanupGatewaySandboxSettings(
  holder: GatewaySandboxSettingsCleanupHolder,
): void {
  const cleanup = holder.gatewaySandboxSettingsCleanup;
  holder.gatewaySandboxSettingsCleanup = undefined;
  cleanup?.();
}
