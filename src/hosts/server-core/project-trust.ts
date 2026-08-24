import { join } from 'node:path';

import { resolveCodexGatewayProfile } from '@main/codex-config/gateway-profiles';
import type { CodexProjectTrustProviderOptions } from '@main/adapters/project-trust/codex';
import { createClaudeProjectTrustProvider } from '@main/adapters/project-trust/claude';
import { createCodexProjectTrustProvider } from '@main/adapters/project-trust/codex';
import { ProjectTrustService } from '@main/adapters/project-trust/core';
import {
  createDirectGrokProjectTrustGrant,
  createGrokProjectTrustProvider,
} from '@main/adapters/project-trust/grok';
import {
  createServerCoreCodexClient,
  HEADLESS_CODEX_EXECUTABLE,
} from './provider-codex-host';
import {
  providerProcessEnvironment,
  type ServerCoreProviderWorkspaceBoundary,
} from './provider-host-common';
import type { ServerCoreProviderSettings } from './provider-settings';
import type { ServerCoreRuntimeDiagnostics } from './repository-host';

export interface ServerCoreProjectTrustOptions {
  readonly providerHomeRoot: string;
  readonly withCodexClient: CodexProjectTrustProviderOptions['withClient'];
}

export function createServerCoreProjectTrustService(
  options: ServerCoreProjectTrustOptions,
): ProjectTrustService {
  const grokHome = join(options.providerHomeRoot, '.grok');
  return new ProjectTrustService({
    'claude-code': createClaudeProjectTrustProvider({
      stateFile: () => join(options.providerHomeRoot, '.claude', '.claude.json'),
    }),
    'codex-cli': createCodexProjectTrustProvider({
      withClient: options.withCodexClient,
    }),
    'grok-build': createGrokProjectTrustProvider({
      grokHome: () => grokHome,
      homeDirectory: () => options.providerHomeRoot,
      grant: createDirectGrokProjectTrustGrant(),
      forceFolderTrustEnabled: true,
    }),
  });
}

export function createServerCoreRuntimeProjectTrust(options: {
  readonly diagnostics: ServerCoreRuntimeDiagnostics;
  readonly providerHomeRoot: string;
  readonly settings: ServerCoreProviderSettings;
  readonly workspaceBoundary: ServerCoreProviderWorkspaceBoundary;
}): ProjectTrustService {
  return createServerCoreProjectTrustService({
    providerHomeRoot: options.providerHomeRoot,
    withCodexClient: async (provider, operation) => {
      const profile = resolveCodexGatewayProfile(provider, {
        gatewaysDir: join(options.providerHomeRoot, '.codex', 'gateways'),
      });
      const client = createServerCoreCodexClient({
        codexPathOverride: options.settings.codexCliPath ?? HEADLESS_CODEX_EXECUTABLE,
        config: profile?.configOverrides ?? null,
        env: {
          ...providerProcessEnvironment({ workspaceBoundary: options.workspaceBoundary }),
          AGENT_DECK_ORIGIN: 'sdk',
        },
      }, {
        diagnostics: options.diagnostics,
        settings: options.settings,
        workspaceBoundary: options.workspaceBoundary,
      });
      try { return await operation(client); } finally { client.dispose(); }
    },
  });
}
