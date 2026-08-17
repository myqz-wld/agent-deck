import { getCodexInstance } from '@main/adapters/codex-cli/codex-instance-pool';
import { resolveCodexGatewayProfile } from '@main/codex-config/gateway-profiles';
import {
  runCodexOneshotWithHost,
  type CodexOneshotOptions,
} from './codex-runner-core';

export type {
  CodexOneshotClient,
  CodexOneshotHost,
  CodexOneshotOptions,
} from './codex-runner-core';
export { runCodexOneshotWithHost } from './codex-runner-core';

/** Desktop Codex app-server oneshot; process pooling stays with the Desktop host. */
export function runCodexOneshot(options: CodexOneshotOptions): Promise<string> {
  return runCodexOneshotWithHost(options, {
    getInstance: getCodexInstance,
    resolveGatewayProfile: resolveCodexGatewayProfile,
  });
}
