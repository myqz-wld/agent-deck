import { assertClaudeGatewayForkTranscriptRootCompatibleCore } from './gateway-fork-safety-core';
import { desktopClaudeGatewayForkSafetyHost } from './gateway-fork-safety-host';
import {
  defaultClaudeGatewayPaths,
  type ClaudeGatewayPaths,
} from './gateway-profiles';

export function assertClaudeGatewayForkTranscriptRootCompatible(
  gateway: string | null | undefined,
  paths: ClaudeGatewayPaths = defaultClaudeGatewayPaths(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  assertClaudeGatewayForkTranscriptRootCompatibleCore(
    gateway,
    paths,
    env,
    desktopClaudeGatewayForkSafetyHost,
  );
}
