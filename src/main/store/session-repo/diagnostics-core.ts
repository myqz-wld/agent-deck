export interface SessionRepositoryDiagnosticsPort {
  warn(
    message: string,
    details?: Readonly<Record<string, unknown>>,
    error?: unknown,
  ): void;
}

const NOOP_SESSION_REPOSITORY_DIAGNOSTICS: SessionRepositoryDiagnosticsPort = {
  warn: () => undefined,
};

let diagnostics: SessionRepositoryDiagnosticsPort =
  NOOP_SESSION_REPOSITORY_DIAGNOSTICS;

/** One process owns one repository graph; its host installs diagnostics before opening ingress. */
export function setSessionRepositoryDiagnostics(
  next: SessionRepositoryDiagnosticsPort | null,
): void {
  diagnostics = next ?? NOOP_SESSION_REPOSITORY_DIAGNOSTICS;
}

export function reportSessionRepositoryWarning(
  message: string,
  details?: Readonly<Record<string, unknown>>,
  error?: unknown,
): void {
  try {
    if (error !== undefined) diagnostics.warn(message, details, error);
    else if (details !== undefined) diagnostics.warn(message, details);
    else diagnostics.warn(message);
  } catch {
    // Observability must never change persistence reads, writes, or recovery fallbacks.
  }
}
