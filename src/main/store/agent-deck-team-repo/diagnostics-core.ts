export interface AgentDeckTeamRepositoryDiagnosticsPort {
  warn(message: string): void;
}

const NOOP: AgentDeckTeamRepositoryDiagnosticsPort = {
  warn: () => undefined,
};

let diagnostics: AgentDeckTeamRepositoryDiagnosticsPort = NOOP;

export function setAgentDeckTeamRepositoryDiagnostics(
  next: AgentDeckTeamRepositoryDiagnosticsPort | null,
): void {
  diagnostics = next ?? NOOP;
}

export function reportAgentDeckTeamRepositoryWarning(message: string): void {
  try {
    diagnostics.warn(message);
  } catch {
    // Diagnostics cannot alter corrupted-row fallback behavior.
  }
}
