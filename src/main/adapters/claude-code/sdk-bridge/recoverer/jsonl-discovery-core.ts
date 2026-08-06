export interface ClaudeJsonlDiscoveryHost {
  transcriptPath(cwd: string, sessionId: string): string;
  pathExists(path: string): boolean;
  pathMtimeMs(path: string): number;
}

/** Fail open so an uncertain preflight never blocks the SDK's authoritative resume attempt. */
export function defaultResumeJsonlExistsCore(
  cwd: string,
  sessionId: string,
  host: ClaudeJsonlDiscoveryHost,
): boolean {
  try {
    return host.pathExists(host.transcriptPath(cwd, sessionId));
  } catch {
    return true;
  }
}

/** Missing or unreadable mtimes cannot satisfy the read-side phantom-fork freshness gate. */
export function defaultResumeJsonlMtimeMsCore(
  cwd: string,
  sessionId: string,
  host: ClaudeJsonlDiscoveryHost,
): number | null {
  try {
    return host.pathMtimeMs(host.transcriptPath(cwd, sessionId));
  } catch {
    return null;
  }
}

/** Fail open so uncertain cwd preflight behavior degrades to the SDK's own path validation. */
export function defaultCwdExistsCore(
  cwd: string,
  host: ClaudeJsonlDiscoveryHost,
): boolean {
  try {
    return host.pathExists(cwd);
  } catch {
    return true;
  }
}
