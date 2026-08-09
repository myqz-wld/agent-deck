import { homedir } from 'node:os';
import { resolveCodexModelProvider } from '@main/codex-config/model-providers';
import { getCodexConfigPath } from '@main/codex-config/toml-writer';
import { claudeGatewaySettingsPath } from './claude-code/gateway-profiles';
import type { SessionCreationDefaultsHost } from './session-creation-defaults-core';

export const desktopSessionCreationDefaultsHost: SessionCreationDefaultsHost = {
  userHome: () => homedir(),
  anthropicModel: () => process.env.ANTHROPIC_MODEL,
  codexConfigPath: () => getCodexConfigPath(),
  resolveCodexModelProvider: (provider, configPath) =>
    resolveCodexModelProvider(provider, configPath),
  claudeGatewaySettingsPath: (provider, gatewaysDir) =>
    claudeGatewaySettingsPath(provider, { gatewaysDir }),
};
