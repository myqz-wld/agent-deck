export interface HandOffDiagnosticsPort {
  warn(message: string, error?: unknown): void;
}

const NOOP_HANDOFF_DIAGNOSTICS: HandOffDiagnosticsPort = {
  warn: () => undefined,
};

let diagnostics: HandOffDiagnosticsPort = NOOP_HANDOFF_DIAGNOSTICS;

export function setHandOffDiagnostics(next: HandOffDiagnosticsPort | null): void {
  diagnostics = next ?? NOOP_HANDOFF_DIAGNOSTICS;
}

export function reportHandOffWarning(message: string, error?: unknown): void {
  try {
    diagnostics.warn(message, error);
  } catch {
    // Diagnostics cannot change handoff ownership or rollback outcomes.
  }
}
