export interface EventRepositoryDiagnosticsPort {
  warn(
    message: string,
    details?: Readonly<Record<string, unknown>>,
    error?: unknown,
  ): void;
}

const NOOP_EVENT_REPOSITORY_DIAGNOSTICS: EventRepositoryDiagnosticsPort = {
  warn: () => undefined,
};

let diagnostics: EventRepositoryDiagnosticsPort =
  NOOP_EVENT_REPOSITORY_DIAGNOSTICS;

/** One process owns one repository graph; its host installs diagnostics before opening ingress. */
export function setEventRepositoryDiagnostics(
  next: EventRepositoryDiagnosticsPort | null,
): void {
  diagnostics = next ?? NOOP_EVENT_REPOSITORY_DIAGNOSTICS;
}

export function reportEventRepositoryWarning(
  message: string,
  details?: Readonly<Record<string, unknown>>,
  error?: unknown,
): void {
  try {
    if (error !== undefined) diagnostics.warn(message, details, error);
    else if (details !== undefined) diagnostics.warn(message, details);
    else diagnostics.warn(message);
  } catch {
    // Observability must never change persistence reads, writes, or corruption fallbacks.
  }
}
