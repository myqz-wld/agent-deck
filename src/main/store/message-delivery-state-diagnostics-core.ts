export interface MessageDeliveryStateDiagnosticsPort {
  warn(message: string): void;
}

const NOOP: MessageDeliveryStateDiagnosticsPort = {
  warn: () => undefined,
};

let diagnostics: MessageDeliveryStateDiagnosticsPort = NOOP;

/** One process installs its own diagnostics without pulling Electron into shared repository code. */
export function setMessageDeliveryStateDiagnostics(
  next: MessageDeliveryStateDiagnosticsPort | null,
): void {
  diagnostics = next ?? NOOP;
}

export function reportMessageDeliveryStateWarning(message: string): void {
  try {
    diagnostics.warn(message);
  } catch {
    // Diagnostics cannot change corruption fallback or delivery-state behavior.
  }
}
