import type { buildSandboxOptions } from '../../sandbox-config';
import {
  cleanupGatewaySandboxSettingsCore,
  prepareGatewaySandboxSettingsCore,
  type GatewaySandboxSettingsCleanupHolder,
  type PreparedGatewaySandboxSettings,
} from './gateway-sandbox-settings-core';
import { desktopGatewaySandboxSettingsHost } from './gateway-sandbox-settings-host';

type SandboxOptions = ReturnType<typeof buildSandboxOptions>;

export type {
  GatewaySandboxSettingsCleanupHolder,
  PreparedGatewaySandboxSettings,
} from './gateway-sandbox-settings-core';

/**
 * Claude Agent SDK 0.3.220 rejects a settings file path together with top-level sandbox options.
 * Keep Gateway credentials isolated to this child process, while a private derived settings file
 * carries the non-env profile fields plus the per-session sandbox configuration.
 */
export function prepareGatewaySandboxSettings(input: {
  settingsPath?: string;
  sandboxOpts: SandboxOptions;
}): PreparedGatewaySandboxSettings {
  return prepareGatewaySandboxSettingsCore(input, desktopGatewaySandboxSettingsHost);
}

export function cleanupGatewaySandboxSettings(
  holder: GatewaySandboxSettingsCleanupHolder,
): void {
  cleanupGatewaySandboxSettingsCore(holder);
}
