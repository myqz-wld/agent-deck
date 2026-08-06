export interface ClaudeGatewayForkPaths {
  gatewaysDir: string;
}

export interface ClaudeGatewayForkProfile {
  id: string;
  configRoot?: string;
}

export interface ClaudeGatewayForkSafetyHost {
  getMainConfigRoot(env: Readonly<Record<string, string | undefined>>): string;
  resolveGatewayProfile(
    gateway: string | null | undefined,
    paths: ClaudeGatewayForkPaths,
  ): ClaudeGatewayForkProfile | null;
  canonicalizeConfigRoot(configRoot: string): string;
}

/**
 * Read-only native-fork preflight. Claude's native fork API does not accept a settings path, so a
 * Gateway profile may fork only when its effective transcript root is the same physical directory
 * used by the main-process Claude SDK.
 */
export function assertClaudeGatewayForkTranscriptRootCompatibleCore(
  gateway: string | null | undefined,
  paths: ClaudeGatewayForkPaths,
  env: Readonly<Record<string, string | undefined>>,
  host: ClaudeGatewayForkSafetyHost,
): void {
  const mainProcessRoot = host.getMainConfigRoot(env);
  const profile = host.resolveGatewayProfile(gateway, paths);
  const gatewayRoot = profile?.configRoot ?? mainProcessRoot;
  if (
    host.canonicalizeConfigRoot(gatewayRoot) === host.canonicalizeConfigRoot(mainProcessRoot)
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
