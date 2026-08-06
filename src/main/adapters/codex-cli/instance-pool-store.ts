export interface DisposableCodexInstance {
  dispose(): void;
}

export interface CodexInstancePoolStore<T extends DisposableCodexInstance> {
  get(configuredPath: string | null | undefined): T;
  invalidate(): void;
}

/**
 * Own the reusable Codex app-server instance without owning desktop settings or process env.
 * The caller supplies the current configured path on every read and constructs the host-specific
 * client only when the normalized identity changes or the cache is explicitly invalidated.
 */
export function createCodexInstancePoolStore<T extends DisposableCodexInstance>(
  createInstance: (overridePath: string | null) => T,
): CodexInstancePoolStore<T> {
  let cachedInstance: T | null = null;
  let cachedPath: string | null = null;

  function get(configuredPath: string | null | undefined): T {
    const overridePath = normalizeOverridePath(configuredPath);
    if (cachedPath !== overridePath) {
      disposeCachedInstance();
      cachedPath = overridePath;
    }
    if (cachedInstance) return cachedInstance;
    cachedInstance = createInstance(overridePath);
    return cachedInstance;
  }

  function invalidate(): void {
    disposeCachedInstance();
    cachedPath = null;
  }

  function disposeCachedInstance(): void {
    cachedInstance?.dispose();
    cachedInstance = null;
  }

  return { get, invalidate };
}

function normalizeOverridePath(
  configuredPath: string | null | undefined,
): string | null {
  return configuredPath?.trim() || null;
}
