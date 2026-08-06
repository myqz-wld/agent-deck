import type { SandboxSettings } from '@anthropic-ai/claude-agent-sdk';

export interface GatewaySandboxOptions {
  sandbox?: SandboxSettings;
}

export interface PreparedGatewaySandboxSettings {
  settingsPath: string | undefined;
  sandboxOpts: GatewaySandboxOptions;
  childEnv: Record<string, string>;
  settingsBackedSandbox: boolean;
  cleanup: (() => void) | undefined;
}

export interface GatewaySandboxSettingsCleanupHolder {
  gatewaySandboxSettingsCleanup?: () => void;
}

export interface MaterializedGatewaySandboxSettings {
  settingsPath: string;
  cleanup: () => void;
}

export interface GatewaySandboxSettingsHost {
  readSettingsText(path: string): string;
  materializeDerivedSettings(serializedSettings: string): MaterializedGatewaySandboxSettings;
}

function readSettingsObject(serializedSettings: string): Record<string, unknown> {
  const parsed = JSON.parse(serializedSettings) as unknown;
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

function exactlyOnce(cleanup: () => void): () => void {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    cleanup();
  };
}

/**
 * Claude Agent SDK rejects a settings path together with top-level sandbox options. Keep Gateway
 * credentials in the child environment and materialize only non-env settings plus sandbox policy.
 */
export function prepareGatewaySandboxSettingsCore(
  input: {
    settingsPath?: string;
    sandboxOpts: GatewaySandboxOptions;
  },
  host: GatewaySandboxSettingsHost,
): PreparedGatewaySandboxSettings {
  if (!input.settingsPath || !input.sandboxOpts.sandbox) {
    return {
      settingsPath: input.settingsPath,
      sandboxOpts: input.sandboxOpts,
      childEnv: {},
      settingsBackedSandbox: false,
      cleanup: undefined,
    };
  }

  const source = readSettingsObject(host.readSettingsText(input.settingsPath));
  const childEnv = stringEnv(source.env);
  const { env: _gatewayEnv, ...settingsWithoutEnv } = source;
  const materialized = host.materializeDerivedSettings(
    JSON.stringify({
      ...settingsWithoutEnv,
      sandbox: input.sandboxOpts.sandbox,
    }),
  );

  return {
    settingsPath: materialized.settingsPath,
    sandboxOpts: {},
    childEnv,
    settingsBackedSandbox: true,
    cleanup: exactlyOnce(materialized.cleanup),
  };
}

export function cleanupGatewaySandboxSettingsCore(
  holder: GatewaySandboxSettingsCleanupHolder,
): void {
  const cleanup = holder.gatewaySandboxSettingsCleanup;
  holder.gatewaySandboxSettingsCleanup = undefined;
  cleanup?.();
}
