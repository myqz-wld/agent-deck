import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

import {
  resolveExplicitGrokOneshotBinary,
  runGrokOneshotWithHost,
} from '@main/adapters/grok-build/run-oneshot-core';
import {
  createCheckpointGeneratorRuntime,
  type CheckpointGeneratorRuntimeHost,
} from '@main/session/continuation-context/runtime-core';
import type { ResolvedContinuationGenerator } from '@main/session/continuation-context/types';
import {
  providerProcessEnvironment,
  type ServerCoreProviderHostInput,
} from './provider-host-common';
import {
  HEADLESS_CLAUDE_EXECUTABLE,
} from './provider-claude-query-host';
import {
  loadServerCoreClaudeSdk,
} from './provider-claude-sdk';
import {
  resolveServerCoreClaudeGatewayProfile,
} from './provider-claude-host';
import {
  createServerCoreCodexClient,
  HEADLESS_CODEX_EXECUTABLE,
} from './provider-codex-host';
import { HEADLESS_GROK_EXECUTABLE } from './provider-grok-host';

export function createServerCoreCheckpointGenerator(
  input: ServerCoreProviderHostInput,
  generator: ResolvedContinuationGenerator,
) {
  const environment = providerProcessEnvironment(input);
  const host: CheckpointGeneratorRuntimeHost = {
    loadClaudeSdk: async () => loadServerCoreClaudeSdk(),
    claudeRuntimeOptions: () => ({
      executable: process.execPath as 'node',
      env: { ...environment },
    }),
    resolveClaudeBinary: () =>
      input.settings.claudeCliPath ?? HEADLESS_CLAUDE_EXECUTABLE,
    resolveClaudeGatewayProfile: (provider) =>
      resolveServerCoreClaudeGatewayProfile(input, provider),
    getCodexInstance: async () => createServerCoreCodexClient({
      codexPathOverride: input.settings.codexCliPath ?? HEADLESS_CODEX_EXECUTABLE,
      config: null,
      env: { ...environment, AGENT_DECK_ORIGIN: 'sdk' },
    }, input),
    releaseCodexInstance: (client) => {
      if ('dispose' in client && typeof client.dispose === 'function') client.dispose();
    },
    runGrokOneshot: (options) => runGrokOneshotWithHost(options, {
      environment,
      temporaryRoot: input.workspaceBoundary.providerTempRoot,
      resolveBinary: resolveExplicitGrokOneshotBinary,
    }),
    grokBinaryPath: () => input.settings.grokCliPath ?? HEADLESS_GROK_EXECUTABLE,
    createIsolatedCwd: (kind) => {
      const root = kind === 'codex'
        ? input.workspaceBoundary.workspaceRoot
        : input.workspaceBoundary.providerTempRoot;
      mkdirSync(root, { recursive: true, mode: 0o700 });
      return mkdtempSync(join(root, `.agent-deck-${kind}-checkpoint-`));
    },
  };
  return createCheckpointGeneratorRuntime(generator, host);
}
