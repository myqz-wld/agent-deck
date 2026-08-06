import type { GrokSessionManagerPort } from './bridge-options';

/** Remove a newly registered strict-startup row after its provider runtime has been disposed. */
export async function cleanupFailedGrokStartupRegistration(
  sessionManager: Pick<GrokSessionManagerPort, 'delete' | 'markClosed'>,
  reportFailure: (sessionId: string, error: unknown) => void,
  sessionId: string,
): Promise<void> {
  try {
    await sessionManager.delete(sessionId);
  } catch (error) {
    reportFailure(sessionId, error);
    // Deletion guards may reject even though the provider process is already gone. A closed row is
    // the conservative fallback and must not remain advertised as an active target.
    sessionManager.markClosed(sessionId);
  }
}
