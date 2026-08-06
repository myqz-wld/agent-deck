/**
 * Temporary fail-closed profile until Server Core materializes a private-state-denying wrapper
 * around each provider-selected Grok profile. The outer Worker sandbox alone also exposes the
 * Worker-private root needed by Core, so passing `off` through here would leak that root to tools.
 */
export const SERVER_CORE_GROK_SANDBOX = 'strict' as const;

export function serverCoreGrokSandbox(_requested: string | null | undefined): 'strict' {
  return SERVER_CORE_GROK_SANDBOX;
}
