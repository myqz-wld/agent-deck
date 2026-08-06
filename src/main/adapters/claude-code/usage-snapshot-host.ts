import { getProviderUsageProbeCwd } from '@main/paths';
import { resolveClaudeBinary } from './resolve-claude-binary';
import { loadSdk } from './sdk-loader';
import { getSdkRuntimeOptions } from './sdk-runtime';
import type { ClaudeUsageSnapshotHost } from './usage-snapshot-core';
import type { ClaudeSessionManagerPort } from './session-manager-core';

export function createDesktopClaudeUsageSnapshotHost(
  sessionManager: Pick<ClaudeSessionManagerPort, 'expectSdkSession'>,
): ClaudeUsageSnapshotHost {
  return {
    loadSdk: async () => {
      const sdk = await loadSdk();
      return { query: (input) => sdk.query(input) };
    },
    getRuntimeOptions: () => getSdkRuntimeOptions(),
    resolveClaudeBinary: () => resolveClaudeBinary(),
    getProbeCwd: () => getProviderUsageProbeCwd(),
    expectSdkSession: (cwd, ttlMs) => sessionManager.expectSdkSession(cwd, ttlMs),
    now: () => Date.now(),
  };
}
