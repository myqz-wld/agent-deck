import type { NodeConfigurationGetResult } from '@contracts/index';
import type { AppSettings } from '@shared/types';

/**
 * Builds the settings view shown for both Relay Worker and Full Core.
 * Desktop-only appearance fields stay local; every server-owned, non-secret field comes from the
 * shared node configuration contract. Remote credentials are deliberately never copied in.
 */
export function presentRemoteSettings(
  localSettings: AppSettings,
  configuration: NodeConfigurationGetResult,
): AppSettings {
  return {
    ...localSettings,
    ...configuration.providerDefaults,
    ...configuration.sessionLifecycle,
    mcpServerToken: null,
  };
}
