import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveClaudeGatewayProfile } from '@main/adapters/claude-code/gateway-profiles';
import { createDesktopCodexAppServerClient } from '@main/adapters/codex-cli/app-server/client-diagnostics';
import { getCodexInstance } from '@main/adapters/codex-cli/codex-instance-pool';
import { GrokAcpProcess } from '@main/adapters/grok-build/acp-process';
import { getGrokHome } from '@main/adapters/grok-build/custom-assets';
import { resolveGrokBinary } from '@main/adapters/grok-build/resolve-grok-binary';
import { resolveCodexGatewayProfile } from '@main/codex-config/gateway-profiles';
import { settingsStore } from '@main/store/settings-store';
import { createClaudeProjectTrustProvider } from './claude';
import { createCodexProjectTrustProvider } from './codex';
import { ProjectTrustService } from './core';
import { createGrokProjectTrustProvider } from './grok';

function processEnvironment(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

async function grantGrokProject(cwd: string): Promise<void> {
  const binary = await resolveGrokBinary(settingsStore.get('grokCliPath'));
  const process = await GrokAcpProcess.start({
    binary,
    cwd,
    authenticate: false,
    trustProject: true,
    onSessionUpdate: () => undefined,
    onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
  });
  await process.stop();
}

export function createDesktopProjectTrustService(): ProjectTrustService {
  return new ProjectTrustService({
    'claude-code': createClaudeProjectTrustProvider({
      stateFile: ({ provider }) => {
        const profile = resolveClaudeGatewayProfile(provider);
        const configured = profile?.configRoot ?? process.env.CLAUDE_CONFIG_DIR?.trim();
        return configured
          ? join(resolve(configured), '.claude.json')
          : join(homedir(), '.claude.json');
      },
    }),
    'codex-cli': createCodexProjectTrustProvider({
      withClient: async (provider, operation) => {
        if (!provider) return operation(await getCodexInstance());
        const profile = resolveCodexGatewayProfile(provider);
        if (!profile) throw new Error('Codex Gateway is unavailable');
        const configuredPath = settingsStore.get('codexCliPath');
        const client = createDesktopCodexAppServerClient({
          codexPathOverride: configuredPath?.trim() || null,
          config: profile.configOverrides,
          env: { ...processEnvironment(), AGENT_DECK_ORIGIN: 'sdk' },
        });
        try { return await operation(client); } finally { client.dispose(); }
      },
    }),
    'grok-build': createGrokProjectTrustProvider({
      grokHome: getGrokHome,
      homeDirectory: homedir,
      grant: ({ cwd }) => grantGrokProject(cwd),
    }),
  });
}

export const desktopProjectTrustService = createDesktopProjectTrustService();
