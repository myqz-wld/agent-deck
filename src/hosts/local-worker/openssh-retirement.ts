import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export class OpenSshChildRetirementError extends Error {
  constructor(readonly killErrors: readonly Error[]) {
    super('OpenSSH child did not exit after bounded SIGTERM and SIGKILL waits');
    this.name = 'OpenSshChildRetirementError';
  }
}

/** One child gets exactly one retirement promise, shared by every failure and close path. */
export class OpenSshChildRetirement {
  private exited = false;
  private retirement: Promise<void> | null = null;
  private readonly exitPromise: Promise<void>;
  private resolveExit!: () => void;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly terminateGraceMs: number,
    private readonly killGraceMs: number,
  ) {
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    child.once('exit', () => this.markExited());
    if (child.exitCode !== null && child.exitCode !== undefined) this.markExited();
    if (child.signalCode !== null && child.signalCode !== undefined) this.markExited();
  }

  markUnavailable(): void {
    this.markExited();
  }

  retire(): Promise<void> {
    this.retirement ??= this.retireOnce();
    return this.retirement;
  }

  private markExited(): void {
    if (this.exited) return;
    this.exited = true;
    this.resolveExit();
  }

  private waitForExit(delayMs: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      let finished = false;
      const finish = (value: boolean): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), delayMs);
      void this.exitPromise.then(() => finish(true));
    });
  }

  private async retireOnce(): Promise<void> {
    if (this.exited) return;
    const killErrors: Error[] = [];
    try {
      this.child.kill('SIGTERM');
    } catch (error) {
      killErrors.push(error instanceof Error ? error : new Error('SIGTERM failed'));
    }
    if (await this.waitForExit(this.terminateGraceMs)) return;
    try {
      this.child.kill('SIGKILL');
    } catch (error) {
      killErrors.push(error instanceof Error ? error : new Error('SIGKILL failed'));
    }
    if (await this.waitForExit(this.killGraceMs)) return;
    throw new OpenSshChildRetirementError(killErrors);
  }
}
