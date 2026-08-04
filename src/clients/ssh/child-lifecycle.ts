import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { SshTransportError } from './errors';

type Timer = ReturnType<typeof setTimeout>;

export interface SshChildRetirementTiming {
  childExitGraceMs: number;
  childExitKillWaitMs: number;
}

/**
 * Owns the one local-child retirement operation from the moment spawn succeeds.
 * It never sends any protocol message or changes the remote Core/session lifecycle.
 */
export class SshChildRetirement {
  private exited = false;
  private retirementPromise: Promise<void> | null = null;
  private readonly exitPromise: Promise<void>;

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private readonly timing: SshChildRetirementTiming,
  ) {
    this.exitPromise = new Promise((resolve) => {
      try {
        child.once('exit', () => {
          this.exited = true;
          resolve();
        });
      } catch {}
    });
  }

  retire(): Promise<void> {
    if (this.retirementPromise) return this.retirementPromise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.retirementPromise = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    void this.retireOnce().then(resolve, reject);
    return this.retirementPromise;
  }

  private async retireOnce(): Promise<void> {
    if (this.exited) return;
    try {
      this.child.stdin.end();
    } catch {}
    try {
      this.child.kill('SIGTERM');
    } catch {}
    if (await this.waitForExit(this.timing.childExitGraceMs)) return;

    try {
      this.child.kill('SIGKILL');
    } catch {}
    if (await this.waitForExit(this.timing.childExitKillWaitMs)) return;
    throw new SshTransportError(
      'child_exit_timeout',
      'Local SSH child did not exit after SIGTERM/SIGKILL; remote Core lifecycle is unchanged',
    );
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      let timer: Timer | null = setTimeout(() => {
        timer = null;
        if (settled) return;
        settled = true;
        resolve(false);
      }, timeoutMs);
      void this.exitPromise.then(() => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        timer = null;
        resolve(true);
      });
    });
  }
}
