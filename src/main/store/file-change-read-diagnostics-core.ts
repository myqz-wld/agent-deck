export interface FileChangeReadDiagnosticsPort {
  warn(message: string, details?: Readonly<Record<string, unknown>>): void;
}

const NOOP: FileChangeReadDiagnosticsPort = { warn: () => undefined };
let diagnostics: FileChangeReadDiagnosticsPort = NOOP;

export function setFileChangeReadDiagnostics(
  next: FileChangeReadDiagnosticsPort | null,
): void {
  diagnostics = next ?? NOOP;
}

export function reportFileChangeReadWarning(
  message: string,
  details?: Readonly<Record<string, unknown>>,
): void {
  try {
    if (details) diagnostics.warn(message, details);
    else diagnostics.warn(message);
  } catch {
    // Diagnostics cannot change bounded read or corruption fallback behavior.
  }
}
