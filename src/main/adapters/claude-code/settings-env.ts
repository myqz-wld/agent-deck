import { applyClaudeSettingsEnvCore } from './settings-env-core';
import { desktopClaudeSettingsEnvHost } from './settings-env-host';

export function applyClaudeSettingsEnv(): void {
  applyClaudeSettingsEnvCore(desktopClaudeSettingsEnvHost);
}
