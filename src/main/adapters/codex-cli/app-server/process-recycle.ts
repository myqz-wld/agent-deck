import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export interface CodexTerminationSignals {
  sigtermSent: boolean;
  sigkillScheduled: boolean;
}

/** Send SIGTERM now and retain a bounded SIGKILL fallback for an uncooperative retired child. */
export function terminateRetiredCodexChild(
  child: ChildProcessWithoutNullStreams,
  onSignalFailure: (signal: 'SIGTERM' | 'SIGKILL') => void,
): CodexTerminationSignals {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { sigtermSent: false, sigkillScheduled: false };
  }
  let sigtermSent = false;
  try {
    sigtermSent = child.kill('SIGTERM');
  } catch {
    // Report through the same structured callback below.
  }
  if (
    !sigtermSent
    && child.exitCode === null
    && child.signalCode === null
  ) {
    onSignalFailure('SIGTERM');
  }

  if (child.exitCode !== null || child.signalCode !== null) {
    return { sigtermSent, sigkillScheduled: false };
  }

  const forceKill = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    let sent = false;
    try {
      sent = child.kill('SIGKILL');
    } catch {
      // Report through the same structured callback below.
    }
    if (!sent) onSignalFailure('SIGKILL');
  }, 1_000);
  forceKill.unref();
  child.once('exit', () => clearTimeout(forceKill));
  return { sigtermSent, sigkillScheduled: true };
}
