import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  LinuxBoundedCommandRunner,
  type CommandDeadlinePort,
  type LinuxCommandSpawn,
} from './bounded-command';

class ManualDeadlines implements CommandDeadlinePort {
  private readonly pending: Array<{ cancelled: boolean; resolve: () => void }> = [];

  wait(): { promise: Promise<void>; cancel(): void } {
    let resolve!: () => void;
    const entry = { cancelled: false, resolve: () => resolve() };
    const promise = new Promise<void>((done) => { resolve = done; });
    this.pending.push(entry);
    return { promise, cancel: () => { entry.cancelled = true; } };
  }

  activeCount(): number {
    return this.pending.filter((entry) => !entry.cancelled).length;
  }

  async expireNext(): Promise<void> {
    const next = this.pending.find((entry) => !entry.cancelled);
    if (!next) throw new Error('missing pending deadline');
    next.cancelled = true;
    next.resolve();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  }
}

class DelayedDrainChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  unreferenced = false;

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }

  unref(): this {
    this.unreferenced = true;
    return this;
  }
}

function runnerFor(
  child: DelayedDrainChild,
  deadlines: ManualDeadlines,
  afterExit?: () => void,
): LinuxBoundedCommandRunner {
  const spawnProcess = (() => {
    setImmediate(() => {
      child.emit('exit', 0);
      if (afterExit) setImmediate(afterExit);
    });
    return child;
  }) as unknown as LinuxCommandSpawn;
  return new LinuxBoundedCommandRunner(
    { platform: 'linux', terminateGraceMs: 2, finalExitWaitMs: 2 },
    spawnProcess,
    {},
    deadlines,
  );
}

function request(maxOutputBytes = 128) {
  return {
    executable: '/usr/bin/podman',
    args: ['volume', 'create', '--', 'agent-deck-instance-a-state'],
    timeoutMs: 10,
    maxOutputBytes,
  } as const;
}

function closeAfterOutput(child: DelayedDrainChild): void {
  child.stdout.end();
  child.stderr.end();
  child.emit('close', 0, null);
}

function expectClean(child: DelayedDrainChild, deadlines: ManualDeadlines): void {
  expect(deadlines.activeCount()).toBe(0);
  for (const event of ['error', 'exit', 'close']) expect(child.listenerCount(event)).toBe(0);
  for (const pipe of [child.stdout, child.stderr]) {
    for (const event of ['data', 'error', 'end', 'close']) expect(pipe.listenerCount(event)).toBe(0);
  }
}

describe('Linux bounded command terminal drain', () => {
  it('retains stdout and stderr delivered one turn after child exit', async () => {
    const child = new DelayedDrainChild();
    const deadlines = new ManualDeadlines();
    const runner = runnerFor(child, deadlines, () => {
      child.stdout.write('agent-deck-instance-a-state\n');
      child.stderr.write('late diagnostic');
      closeAfterOutput(child);
    });

    await expect(runner.run(request())).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'agent-deck-instance-a-state\n',
      stderr: 'late diagnostic',
      outputTruncated: false,
    });
    expectClean(child, deadlines);
  });

  it('applies the combined output cap to exit-delayed chunks', async () => {
    const child = new DelayedDrainChild();
    const deadlines = new ManualDeadlines();
    const runner = runnerFor(child, deadlines, () => {
      child.stdout.write('abcde');
      child.stderr.write('fghij');
      closeAfterOutput(child);
    });

    await expect(runner.run(request(7))).resolves.toMatchObject({
      stdout: 'abcde',
      stderr: 'fg',
      outputTruncated: true,
    });
    expectClean(child, deadlines);
  });

  it('fails with a fixed error when a pipe errors after exit', async () => {
    const child = new DelayedDrainChild();
    const deadlines = new ManualDeadlines();
    const runner = runnerFor(child, deadlines, () => {
      child.stdout.emit('error', new Error('raw-secret-path'));
      closeAfterOutput(child);
    });

    const operation = runner.run(request());
    await expect(operation).rejects.toMatchObject({
      code: 'command_failed',
      message: 'Command output stream failed',
    });
    await expect(operation).rejects.not.toThrow('raw-secret-path');
    expectClean(child, deadlines);
  });

  it('bounds a child that exits without closing either output pipe', async () => {
    const child = new DelayedDrainChild();
    const deadlines = new ManualDeadlines();
    const runner = runnerFor(child, deadlines);
    const operation = runner.run(request());
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(deadlines.activeCount()).toBe(1);

    await deadlines.expireNext();
    await expect(operation).rejects.toMatchObject({
      code: 'command_failed',
      message: 'Command output exceeded its terminal drain bound',
    });
    expect(child.unreferenced).toBe(true);
    expectClean(child, deadlines);
  });
});
