import { realpathSync } from 'node:fs';
import { normalize, resolve } from 'node:path';

import { getClaudeConfigRoot } from './fork-session';
import {
  defaultClaudeGatewayPaths,
  resolveClaudeGatewayProfile,
  type ClaudeGatewayPaths,
} from './gateway-profiles';

function comparableConfigRoot(configRoot: string): string {
  const absolute = resolve(configRoot);
  try {
    return normalize(realpathSync(absolute)).normalize('NFC');
  } catch {
    return normalize(absolute).normalize('NFC');
  }
}

/**
 * Read-only native-fork preflight. Claude's native fork API does not accept a settings path, so a
 * Gateway profile may fork only when its effective transcript root is the same physical directory
 * used by the main-process Claude SDK.
 */
export function assertClaudeGatewayForkTranscriptRootCompatible(
  provider: string | null | undefined,
  paths: ClaudeGatewayPaths = defaultClaudeGatewayPaths(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const mainProcessRoot = getClaudeConfigRoot(env);
  const profile = resolveClaudeGatewayProfile(provider, paths);
  const gatewayRoot = profile?.configRoot ?? mainProcessRoot;
  if (
    comparableConfigRoot(gatewayRoot) === comparableConfigRoot(mainProcessRoot)
  ) {
    return;
  }

  throw new Error(
    `Claude Gateway profile "${profile?.id}" native fork cannot safely locate the source ` +
      `transcript because its effective CLAUDE_CONFIG_DIR (${gatewayRoot}) differs from the ` +
      `main-process Claude transcript root (${mainProcessRoot}). Use the main transcript root ` +
      'or use contextMode "fresh".',
  );
}
