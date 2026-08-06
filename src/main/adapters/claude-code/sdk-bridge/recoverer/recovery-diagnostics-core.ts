import type { RecoveryWarningThunk } from './_deps';

/** A diagnostic observer cannot change recovery, cancellation, or cleanup authority. */
export function warnRecoveryWithoutThrow(
  warn: RecoveryWarningThunk,
  message: string,
  error?: unknown,
): void {
  try {
    warn(message, error);
  } catch {
    // Desktop diagnostics are secondary to the recovery state machine.
  }
}
