import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getSdkRuntimeOptions } from '@main/adapters/claude-code/sdk-runtime';
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';
import { resolveClaudeBinary } from '@main/adapters/claude-code/resolve-claude-binary';
import { resolveClaudeGatewayProfile } from '@main/adapters/claude-code/gateway-profiles';
import { getCodexInstance } from '@main/adapters/codex-cli/codex-instance-pool';
import { runGrokOneshot } from '@main/session/oneshot-llm';
import { settingsStore } from '@main/store/settings-store';
import type { ResolvedContinuationGenerator } from './types';
import {
  createCheckpointGeneratorRuntime as createRuntimeWithHost,
  type CheckpointGeneratorRuntimeHost,
} from './runtime-core';

export { clearGatewayCheckpointCapabilityCache } from './runtime-core';
export type { CheckpointGeneratorRuntimeHost } from './runtime-core';

const desktopHost: CheckpointGeneratorRuntimeHost = {
  loadClaudeSdk: async () => loadSdk(),
  claudeRuntimeOptions: getSdkRuntimeOptions,
  resolveClaudeBinary,
  resolveClaudeGatewayProfile: (provider) => resolveClaudeGatewayProfile(provider),
  getCodexInstance,
  runGrokOneshot,
  grokBinaryPath: () => settingsStore.get('grokCliPath'),
  createIsolatedCwd: (kind) => mkdtempSync(join(
    tmpdir(),
    kind === 'codex'
      ? 'agent-deck-codex-continuation-compactor-'
      : 'agent-deck-continuation-compactor-',
  )),
};

export function createCheckpointGeneratorRuntime(generator: ResolvedContinuationGenerator) {
  return createRuntimeWithHost(generator, desktopHost);
}
