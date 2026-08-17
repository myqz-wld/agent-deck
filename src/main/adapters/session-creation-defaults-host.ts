import { homedir } from 'node:os';
import { resolveCodexGatewayProfile } from '@main/codex-config/gateway-profiles';
import { getCodexConfigPath } from '@main/codex-config/toml-writer';
import { claudeGatewaySettingsPath } from './claude-code/gateway-profiles';
import type { SessionCreationDefaultsHost } from './session-creation-defaults-core';

export const desktopSessionCreationDefaultsHost: SessionCreationDefaultsHost = {
  userHome: () => homedir(),
  anthropicModel: () => process.env.ANTHROPIC_MODEL,
  codexConfigPath: () => getCodexConfigPath(),
  resolveCodexGatewayProfile: (provider) => resolveCodexGatewayProfile(provider),
  claudeGatewaySettingsPath: (provider, gatewaysDir) =>
    claudeGatewaySettingsPath(provider, { gatewaysDir }),
};
