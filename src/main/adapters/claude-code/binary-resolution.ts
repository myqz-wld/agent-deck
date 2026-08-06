export type ClaudeBinaryState = 'healthy' | 'override-missing';

export interface ClaudeBinaryResolutionPorts {
  pathExists(path: string): boolean;
  bundledBinary(): string | undefined;
  observeState?(state: ClaudeBinaryState): void;
}

/**
 * Resolve one caller-supplied Claude executable override without owning settings or diagnostics.
 * Filesystem and packaged-binary discovery remain explicit host ports so the same policy can run
 * under Electron or a plain Node Core host.
 */
export function resolveClaudeBinaryFromConfig(
  configuredPath: string | null | undefined,
  ports: ClaudeBinaryResolutionPorts,
): string | undefined {
  const userOverride = configuredPath?.trim();
  if (userOverride && ports.pathExists(userOverride)) {
    safelyObserve(ports, 'healthy');
    return userOverride;
  }

  const fallback = ports.bundledBinary();
  safelyObserve(ports, userOverride ? 'override-missing' : 'healthy');
  return fallback;
}

function safelyObserve(
  ports: ClaudeBinaryResolutionPorts,
  state: ClaudeBinaryState,
): void {
  try {
    ports.observeState?.(state);
  } catch {
    // Diagnostics cannot alter override priority or fallback behavior.
  }
}
