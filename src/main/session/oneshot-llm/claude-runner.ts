import { getSdkRuntimeOptions } from '@main/adapters/claude-code/sdk-runtime';
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';
import { resolveClaudeBinary } from '@main/adapters/claude-code/resolve-claude-binary';
import {
  runClaudeOneshotWithHost,
  type ClaudeOneshotOptions,
} from './claude-runner-core';

export type { ClaudeOneshotHost, ClaudeOneshotOptions } from './claude-runner-core';
export { runClaudeOneshotWithHost } from './claude-runner-core';

/** Desktop Claude SDK oneshot; provider-specific selection stays with the caller. */
export function runClaudeOneshot(options: ClaudeOneshotOptions): Promise<string> {
  return runClaudeOneshotWithHost(options, {
    loadSdk: async () => loadSdk(),
    runtimeOptions: getSdkRuntimeOptions,
    resolveBinary: resolveClaudeBinary,
  });
}
