import { EventEmitter, once } from 'node:events';
import type { spawn } from 'node:child_process';
import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import {
  NodeServerCorePodmanHost,
  type PodmanBridgeDeadlinePort,
} from './podman-bridge-host';
import {
  runServerCorePodmanBridge,
  type ServerCorePodmanHostPort,
} from './podman-bridge';

function inspection(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify([{
    Id: 'a'.repeat(64),
    Name: 'agent-deck-server-core-instance-a',
    State: { Running: true, Status: 'running' },
    Config: { Labels: {
      'io.agent-deck.instance': 'instance-a',
      'io.agent-deck.topology': 'full',
      'io.agent-deck.managed-by': 'agent-deck-instance-manager',
    } },
    ...overrides,
  }]);
}

class FakeHost implements ServerCorePodmanHostPort {
  readonly captures: string[][] = [];
  readonly streams: string[][] = [];
  readonly outputs = [
    '{"host":{"security":{"rootless":true}}}',
    inspection(),
  ];

  async capture(args: readonly string[]): Promise<string> {
    this.captures.push([...args]);
    const output = this.outputs.shift();
    if (!output) throw new Error('missing output');
    return output;
  }

  async stream(args: readonly string[]): Promise<void> {
    this.streams.push([...args]);
  }
}

class ManualDeadlines implements PodmanBridgeDeadlinePort {
  private readonly waits: Array<{ cancelled: boolean; resolve: () => void }> = [];

  wait(): { promise: Promise<void>; cancel(): void } {
    let resolve!: () => void;
    const entry = { cancelled: false, resolve: () => resolve() };
    const promise = new Promise<void>((done) => { resolve = done; });
    this.waits.push(entry);
    return { promise, cancel: () => { entry.cancelled = true; } };
  }

  activeCount(): number {
    return this.waits.filter((entry) => !entry.cancelled).length;
  }

  async expireNext(): Promise<void> {
    const next = this.waits.find((entry) => !entry.cancelled);
    if (!next) throw new Error('missing deadline');
    next.cancelled = true;
    next.resolve();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  }
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  unreferenced = false;
  exitOnSignal = false;

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (this.exitOnSignal) {
      this.stdout.end();
      this.stderr.end();
      queueMicrotask(() => this.emit('exit', null));
    }
    return true;
  }

  unref(): this {
    this.unreferenced = true;
    return this;
  }
}

function podmanHost(child: FakeChild, deadlines: ManualDeadlines): NodeServerCorePodmanHost {
  return new NodeServerCorePodmanHost({
    platform: 'linux',
    getUid: () => 1001,
    spawnProcess: (() => child) as unknown as typeof spawn,
    deadlines,
  });
}

function closeCapture(child: FakeChild): void {
  child.stdout.end();
  child.stderr.end();
  child.emit('close', 0, null);
}

function expectCaptureClean(child: FakeChild, deadlines: ManualDeadlines): void {
  expect(deadlines.activeCount()).toBe(0);
  for (const event of ['error', 'exit', 'close']) expect(child.listenerCount(event)).toBe(0);
  for (const pipe of [child.stdout, child.stderr]) {
    for (const event of ['data', 'error', 'end', 'close']) expect(pipe.listenerCount(event)).toBe(0);
  }
}

describe('Full Server Core rootless Podman bridge', () => {
  it('binds original command, instance, credential, running container id, and internal socket', async () => {
    const host = new FakeHost();
    await runServerCorePodmanBridge(host, {
      instanceId: 'instance-a',
      credentialId: 'credential-a',
      surface: 'desktop',
      originalCommand: 'agent-deck-bridge',
      input: Readable.from([]),
      output: new PassThrough(),
    });
    expect(host.captures).toEqual([
      ['info', '--format=json'],
      ['container', 'inspect', '--format=json', '--', 'agent-deck-server-core-instance-a'],
    ]);
    expect(host.streams).toEqual([[
      'exec', '-i', '--detach-keys=', '--', 'a'.repeat(64),
      '/opt/agent-deck/bin/agent-deckd', 'bridge-internal',
      '--instance', 'instance-a', '--credential', 'credential-a',
      '--surface', 'desktop',
      '--socket', '/run/agent-deck/instance-a/agent-deckd.sock',
    ]]);
  });

  it('rejects original-command and container identity mismatches before streaming', async () => {
    const original = new FakeHost();
    await expect(runServerCorePodmanBridge(original, {
      instanceId: 'instance-a', credentialId: 'credential-a',
      surface: 'desktop',
      originalCommand: 'agent-deck-bridge --other',
      input: Readable.from([]), output: new PassThrough(),
    })).rejects.toThrow('original command');
    expect(original.captures).toEqual([]);

    for (const tampered of [
      inspection({ Name: 'agent-deck-server-core-other' }),
      inspection({ State: { Running: false, Status: 'exited' } }),
      inspection({ Config: { Labels: {
        'io.agent-deck.instance': 'instance-a',
        'io.agent-deck.topology': 'full',
        'io.agent-deck.managed-by': 'other-manager',
      } } }),
    ]) {
      const replaced = new FakeHost();
      replaced.outputs[1] = tampered;
      await expect(runServerCorePodmanBridge(replaced, {
        instanceId: 'instance-a', credentialId: 'credential-a',
        surface: 'desktop',
        originalCommand: 'agent-deck-bridge',
        input: Readable.from([]), output: new PassThrough(),
      })).rejects.toThrow('identity is not exact and running');
      expect(replaced.streams).toEqual([]);
    }
  });

  it.each(['Instance-a', '实例-a', 'a'.repeat(64), '-instance', 'instance-'])(
    'rejects instance %s before deriving a container name',
    async (instanceId) => {
      const host = new FakeHost();
      await expect(runServerCorePodmanBridge(host, {
        instanceId, credentialId: 'credential-a', originalCommand: 'agent-deck-bridge',
        surface: 'desktop',
        input: Readable.from([]), output: new PassThrough(),
      })).rejects.toThrow('lowercase Linux instance label');
      expect(host.captures).toEqual([]);
    },
  );

  it('has a deterministic terminal bound when Podman never reports exit', async () => {
    const child = new FakeChild();
    const deadlines = new ManualDeadlines();
    const host = new NodeServerCorePodmanHost({
      platform: 'linux',
      getUid: () => 1001,
      spawnProcess: (() => child) as unknown as typeof spawn,
      deadlines,
    });
    const operation = host.capture(['info', '--format=json']);
    await deadlines.expireNext();
    expect(child.signals).toEqual(['SIGTERM']);
    await deadlines.expireNext();
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    await deadlines.expireNext();
    await expect(operation).rejects.toThrow('inspection failed');
    expect(child.unreferenced).toBe(true);
    expect(child.listenerCount('exit')).toBe(0);
  });

  it('captures stdout delivered one event-loop turn after child exit', async () => {
    const child = new FakeChild();
    const deadlines = new ManualDeadlines();
    const operation = podmanHost(child, deadlines).capture(['info', '--format=json']);
    child.emit('exit', 0);
    setImmediate(() => {
      child.stdout.write('{"host":{"security":{"rootless":true}}}');
      closeCapture(child);
    });

    await expect(operation).resolves.toBe('{"host":{"security":{"rootless":true}}}');
    expectCaptureClean(child, deadlines);
  });

  it('rejects exit-delayed stderr and oversized stdout', async () => {
    const stderrChild = new FakeChild();
    const stderrDeadlines = new ManualDeadlines();
    const stderrOperation = podmanHost(stderrChild, stderrDeadlines).capture(['info']);
    stderrChild.emit('exit', 0);
    setImmediate(() => {
      stderrChild.stderr.write('late raw diagnostic');
      closeCapture(stderrChild);
    });
    await expect(stderrOperation).rejects.toThrow('inspection failed');
    expectCaptureClean(stderrChild, stderrDeadlines);

    const oversizedChild = new FakeChild();
    const oversizedDeadlines = new ManualDeadlines();
    const oversizedOperation = podmanHost(oversizedChild, oversizedDeadlines).capture(['info']);
    oversizedChild.emit('exit', 0);
    setImmediate(() => {
      oversizedChild.stdout.write(Buffer.alloc(1024 * 1024 + 1, 0x61));
      closeCapture(oversizedChild);
    });
    await expect(oversizedOperation).rejects.toThrow('inspection failed');
    expectCaptureClean(oversizedChild, oversizedDeadlines);
  });

  it('fails closed on an output error delivered after child exit', async () => {
    const child = new FakeChild();
    const deadlines = new ManualDeadlines();
    const operation = podmanHost(child, deadlines).capture(['info']);
    child.emit('exit', 0);
    setImmediate(() => {
      child.stdout.emit('error', new Error('raw-secret-path'));
      closeCapture(child);
    });

    await expect(operation).rejects.toThrow('Rootless Podman inspection failed');
    await expect(operation).rejects.not.toThrow('raw-secret-path');
    expectCaptureClean(child, deadlines);
  });

  it('bounds capture when an exited child never closes its output pipes', async () => {
    const child = new FakeChild();
    const deadlines = new ManualDeadlines();
    const operation = podmanHost(child, deadlines).capture(['info']);
    child.emit('exit', 0);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(deadlines.activeCount()).toBe(1);

    await deadlines.expireNext();
    await expect(operation).rejects.toThrow('Rootless Podman inspection failed');
    expect(child.unreferenced).toBe(true);
    expectCaptureClean(child, deadlines);
  });

  it('streams only stdin/stdout with backpressure and a minimal fixed environment', async () => {
    const child = new FakeChild();
    const deadlines = new ManualDeadlines();
    let spawnOptions: Record<string, unknown> | undefined;
    const spawnProcess = vi.fn((_file, _args, options) => {
      spawnOptions = options as Record<string, unknown>;
      return child;
    }) as unknown as typeof spawn;
    const host = new NodeServerCorePodmanHost({
      platform: 'linux', getUid: () => 1001, spawnProcess, deadlines,
    });
    const inbound: Buffer[] = [];
    child.stdin.on('data', (chunk: Buffer) => inbound.push(Buffer.from(chunk)));
    const outbound: Buffer[] = [];
    const output = new Writable({
      highWaterMark: 1,
      write(chunk: Buffer, _encoding, callback): void {
        outbound.push(Buffer.from(chunk));
        queueMicrotask(callback);
      },
    });
    const operation = host.stream(['exec', '--interactive', '--', 'container-id', 'command'], {
      input: Readable.from([Buffer.from('request')]),
      output,
    });
    await once(child.stdin, 'finish');
    child.stdout.end(Buffer.from('response'));
    child.stderr.end();
    child.emit('exit', 0);
    await expect(operation).resolves.toBeUndefined();
    expect(Buffer.concat(inbound).toString()).toBe('request');
    expect(Buffer.concat(outbound).toString()).toBe('response');
    expect(spawnOptions).toMatchObject({
      shell: false,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/var/lib/agent-deck',
        XDG_RUNTIME_DIR: '/run/user/1001',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1001/bus',
      },
    });
    expect(JSON.stringify(spawnOptions)).not.toMatch(/LD_PRELOAD|NODE_OPTIONS|BASH_ENV/);
  });

  it('bounds a slow SSH output drain without turning a clean child exit into failure', async () => {
    const child = new FakeChild();
    const deadlines = new ManualDeadlines();
    const writeCallbacks: Array<() => void> = [];
    const output = new Writable({
      write(_chunk: Buffer, _encoding, callback): void {
        writeCallbacks.push(callback);
      },
    });
    const host = new NodeServerCorePodmanHost({
      platform: 'linux',
      getUid: () => 1001,
      spawnProcess: (() => child) as unknown as typeof spawn,
      deadlines,
    });
    const operation = host.stream(['exec', '--', 'container-id', 'command'], {
      input: Readable.from([]),
      output,
    });
    child.stdout.write(Buffer.from('tail'));
    child.stdout.end();
    child.stderr.end();
    child.emit('exit', 0);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    await deadlines.expireNext();
    await expect(operation).resolves.toBeUndefined();
    writeCallbacks.shift()?.();
  });

  it('turns an already-aborted signal into bounded child termination', async () => {
    const child = new FakeChild();
    child.exitOnSignal = true;
    const abort = new AbortController();
    abort.abort();
    const host = new NodeServerCorePodmanHost({
      platform: 'linux',
      getUid: () => 1001,
      spawnProcess: (() => child) as unknown as typeof spawn,
      deadlines: new ManualDeadlines(),
    });
    await expect(host.stream(['exec', '--', 'container-id', 'command'], {
      input: Readable.from([]),
      output: new PassThrough(),
      signal: abort.signal,
    })).rejects.toThrow('bridge process failed');
    expect(child.signals).toEqual(['SIGTERM']);
  });
});
