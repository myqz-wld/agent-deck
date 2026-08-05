import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, writeFileSync } from 'node:fs';
import { chmod, lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CommandPort,
  CommandRequest,
  CommandResult,
  FileIdentity,
} from '../types';
import {
  LinuxBoundedCommandRunner,
  type CommandDeadlinePort,
  type LinuxCommandSpawn,
} from './bounded-command';
import { RootlessPodmanCommandPort } from './podman-rootless';
import { SystemdUserCommandPort } from './systemd-user';

const temporary: string[] = [];

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

function fileIdentity(stat: Awaited<ReturnType<typeof lstat>>): FileIdentity {
  return {
    device: Number(stat.dev),
    inode: Number(stat.ino),
    kind: stat.isFile() ? 'file' : 'other',
    mode: Number(stat.mode),
    uid: Number(stat.uid),
    size: Number(stat.size),
    modifiedAtMs: Number(stat.mtimeMs),
  };
}

class ScriptedCommands implements CommandPort {
  readonly requests: CommandRequest[] = [];
  readonly results: CommandResult[] = [];

  async run(request: CommandRequest): Promise<CommandResult> {
    this.requests.push(request);
    const result = this.results.shift();
    if (!result) throw new Error('missing scripted result');
    return result;
  }
}

function ok(stdout = ''): CommandResult {
  return { exitCode: 0, stdout, stderr: '', timedOut: false, outputTruncated: false };
}

class ManualDeadlines implements CommandDeadlinePort {
  private readonly pending: Array<{ cancelled: boolean; resolve: () => void }> = [];

  wait(): { promise: Promise<void>; cancel(): void } {
    let resolve!: () => void;
    const entry = { cancelled: false, resolve: () => resolve() };
    const promise = new Promise<void>((done) => { resolve = done; });
    this.pending.push(entry);
    return { promise, cancel: () => { entry.cancelled = true; } };
  }

  async expireNext(): Promise<void> {
    const next = this.pending.find((entry) => !entry.cancelled);
    if (!next) throw new Error('missing pending deadline');
    next.cancelled = true;
    next.resolve();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  }
}

class NeverExitsChild extends EventEmitter {
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

function completingSpawn(input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly beforeExit?: () => void;
  readonly inspect?: (
    executable: string,
    args: readonly string[],
    options: Readonly<Record<string, unknown>>,
  ) => void;
} = {}): LinuxCommandSpawn {
  return ((executable: string, args: readonly string[], options: Record<string, unknown>) => {
    const child = new NeverExitsChild();
    input.inspect?.(executable, args, options);
    const once = child.once.bind(child);
    let scheduled = false;
    child.once = ((eventName: string | symbol, listener: (...args: unknown[]) => void) => {
      const result = once(eventName, listener);
      if (eventName === 'exit' && !scheduled) {
        scheduled = true;
        queueMicrotask(() => {
          input.beforeExit?.();
          if (input.stdout) child.stdout.write(input.stdout);
          if (input.stderr) child.stderr.write(input.stderr);
          child.emit('exit', input.exitCode ?? 0);
          child.stdout.end();
          child.stderr.end();
          child.emit('close', input.exitCode ?? 0, null);
        });
      }
      return result;
    }) as typeof child.once;
    return child;
  }) as unknown as LinuxCommandSpawn;
}

describe('Linux bounded command runner', () => {
  it('executes argv without a shell and applies one combined output bound', async () => {
    const inspect = vi.fn();
    const runner = new LinuxBoundedCommandRunner(
      { platform: 'linux' },
      completingSpawn({ stdout: 'abcdef', inspect }),
    );
    const result = await runner.run({
      executable: '/usr/bin/test-command',
      args: ['-e', "process.stdout.write('abcdef')"],
      timeoutMs: 2_000,
      maxOutputBytes: 4,
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: 'abcd', outputTruncated: true });
    expect(inspect).toHaveBeenCalledWith(
      '/usr/bin/test-command',
      ['-e', "process.stdout.write('abcdef')"],
      expect.objectContaining({ shell: false }),
    );
  });

  it('rechecks a trusted artifact after command execution and redacts its path', async () => {
    const created = await mkdtemp(join(tmpdir(), 'agent-deck-command-'));
    const root = await realpath(created);
    temporary.push(root);
    const artifactPath = join(root, 'trusted');
    await writeFile(artifactPath, 'trusted');
    await chmod(artifactPath, 0o444);
    const bytes = Buffer.from('trusted');
    const artifact = {
      path: artifactPath,
      identity: fileIdentity(await lstat(artifactPath)),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const runner = new LinuxBoundedCommandRunner(
      { platform: 'linux' },
      completingSpawn({
        beforeExit: () => {
          chmodSync(artifactPath, 0o600);
          writeFileSync(artifactPath, 'changed');
        },
      }),
    );
    const operation = runner.run({
      executable: '/usr/bin/test-command',
      args: [
        '-e',
        'mutate-trusted-artifact',
        artifactPath,
      ],
      timeoutMs: 2_000,
      maxOutputBytes: 128,
      trustedArtifacts: [artifact],
    });
    await expect(operation).rejects.toMatchObject({
      code: 'trust_failed',
      message: 'Trusted command artifact did not match its exact fence',
    });
    await expect(operation).rejects.not.toThrow(artifactPath);
  });

  it('bounds timeout, SIGTERM grace, SIGKILL, and a child that never reports exit', async () => {
    const child = new NeverExitsChild();
    const deadlines = new ManualDeadlines();
    const spawnProcess = (() => child) as unknown as LinuxCommandSpawn;
    const runner = new LinuxBoundedCommandRunner(
      { platform: 'linux', terminateGraceMs: 2, finalExitWaitMs: 2 },
      spawnProcess,
      {},
      deadlines,
    );
    const operation = runner.run({
      executable: '/usr/bin/never-exits',
      args: ['bounded'],
      timeoutMs: 10,
      maxOutputBytes: 128,
    });
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    await deadlines.expireNext();
    expect(child.signals).toEqual(['SIGTERM']);
    await deadlines.expireNext();
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    await deadlines.expireNext();
    await expect(operation).rejects.toMatchObject({
      code: 'command_failed',
      message: 'Command exceeded its terminal bound',
    });
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
    expect(child.stdout.listenerCount('data')).toBe(0);
    expect(child.stdout.listenerCount('end')).toBe(0);
    expect(child.stdout.listenerCount('close')).toBe(0);
    expect(child.stdout.listenerCount('error')).toBe(0);
    expect(child.stderr.listenerCount('data')).toBe(0);
    expect(child.stderr.listenerCount('end')).toBe(0);
    expect(child.stderr.listenerCount('close')).toBe(0);
    expect(child.stderr.listenerCount('error')).toBe(0);
    expect(child.unreferenced).toBe(true);
  });

  it.each(['LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS', 'BASH_ENV', 'ENV'])(
    'rejects loader/runtime injection through %s',
    async (key) => {
      const runner = new LinuxBoundedCommandRunner({ platform: 'linux' });
      await expect(runner.run({
        executable: process.execPath,
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 2_000,
        maxOutputBytes: 128,
        environment: { [key]: 'injected' },
      })).rejects.toThrow('environment was rejected');
    },
  );

  it('rejects production termination phases above the fixed ceiling', () => {
    expect(() => new LinuxBoundedCommandRunner({
      platform: 'linux',
      terminateGraceMs: 30_001,
    })).toThrow('termination bounds');
    expect(() => new LinuxBoundedCommandRunner({
      platform: 'linux',
      finalExitWaitMs: 30_001,
    })).toThrow('termination bounds');
  });

  it('accepts only the fixed rootless user-manager environment fields', async () => {
    const inspect = vi.fn();
    const runner = new LinuxBoundedCommandRunner(
      { platform: 'linux' },
      completingSpawn({ inspect }),
      {
        HOME: '/var/lib/agent-deck',
        XDG_RUNTIME_DIR: '/run/user/1001',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1001/bus',
      },
    );
    await expect(runner.run({
      executable: '/usr/bin/test-command',
      args: ['-e', 'process.exit(0)'],
      timeoutMs: 2_000,
      maxOutputBytes: 128,
      environment: { AGENT_DECK_VOLUME_QUOTA_READY: 'verified' },
    })).resolves.toMatchObject({ exitCode: 0, timedOut: false });
    expect(inspect).toHaveBeenCalledWith(
      '/usr/bin/test-command',
      ['-e', 'process.exit(0)'],
      expect.objectContaining({
        env: {
          PATH: '/usr/bin:/bin',
          LANG: 'C',
          LC_ALL: 'C',
          HOME: '/var/lib/agent-deck',
          XDG_RUNTIME_DIR: '/run/user/1001',
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1001/bus',
          AGENT_DECK_VOLUME_QUOTA_READY: 'verified',
        },
      }),
    );
  });
});

describe('systemd-user and rootless Podman ports', () => {
  it('mutates only one exact user-manager unit through argv', async () => {
    const commands = new ScriptedCommands();
    commands.results.push(ok(), ok(), ok());
    const systemd = new SystemdUserCommandPort(commands);
    await systemd.daemonReload(1_000);
    await systemd.startUserUnit('agent-deck-relay@instance-a.service', 1_000);
    await systemd.stopUserUnit('agent-deck-relay@instance-a.service', 1_000);
    expect(commands.requests.map((request) => request.args)).toEqual([
      ['--user', 'daemon-reload'],
      ['--user', 'start', '--', 'agent-deck-relay@instance-a.service'],
      ['--user', 'stop', '--', 'agent-deck-relay@instance-a.service'],
    ]);
  });

  it('uses exact systemd-user argv and parses only the bounded show schema', async () => {
    const commands = new ScriptedCommands();
    commands.results.push(ok([
      'Id=agent-deck-full@instance-a.service',
      'FragmentPath=/generated/service',
      'SourcePath=/units/agent-deck-full@instance-a.container',
      'LoadState=loaded',
      'ActiveState=active',
      'SubState=running',
      '',
    ].join('\n')));
    const systemd = new SystemdUserCommandPort(commands);
    await expect(systemd.statusUserUnit('agent-deck-full@instance-a.service', 1000))
      .resolves.toMatchObject({
        fragmentPath: '/units/agent-deck-full@instance-a.container',
        activeState: 'active',
      });
    expect(commands.requests[0]?.args).toEqual([
      '--user', 'show', '--no-pager',
      '--property=Id,FragmentPath,SourcePath,LoadState,ActiveState,SubState',
      '--', 'agent-deck-full@instance-a.service',
    ]);
  });

  it.each(['Instance-a', '实例-a', 'a'.repeat(64), '-instance', 'instance-'])(
    'rejects non-exact systemd instance %s before argv execution',
    async (instanceId) => {
      const commands = new ScriptedCommands();
      const systemd = new SystemdUserCommandPort(commands);
      await expect(systemd.startUserUnit(
        `agent-deck-full@${instanceId}.service`,
        1_000,
      )).rejects.toThrow('unit name was rejected');
      expect(commands.requests).toEqual([]);
    },
  );

  it('requires rootless Podman before inspecting one digest-pinned image', async () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    const reference = `registry.example/agent-deck@${digest}`;
    const commands = new ScriptedCommands();
    commands.results.push(
      ok('{"host":{"security":{"rootless":true}}}'),
      ok(),
      ok(JSON.stringify([{ Digest: digest }])),
    );
    const podman = new RootlessPodmanCommandPort(commands);
    await expect(podman.inspectImage(reference, 1_000)).resolves.toEqual({ reference, digest });
    expect(commands.requests.map((request) => request.args)).toEqual([
      ['info', '--format=json'],
      ['image', 'exists', '--', reference],
      ['image', 'inspect', '--format=json', '--', reference],
    ]);
  });

  it('creates and removes only the same inspected rootless volume identity', async () => {
    const commands = new ScriptedCommands();
    const inspected = JSON.stringify([{
      Name: 'agent-deck-instance-a-state',
      Mountpoint: '/storage/volumes/instance-a/_data',
      CreatedAt: '2026-01-01T00:00:00Z',
      Labels: { 'io.agent-deck.instance': 'instance-a' },
    }]);
    commands.results.push(
      ok('{"host":{"security":{"rootless":true}}}'),
      ok('agent-deck-instance-a-state\n'),
      ok(),
      ok(inspected),
      ok(),
      ok(inspected),
      ok(),
      ok(inspected),
      ok('agent-deck-instance-a-state\n'),
    );
    const podman = new RootlessPodmanCommandPort(commands);
    const volume = await podman.createVolume(
      'agent-deck-instance-a-state',
      { 'io.agent-deck.instance': 'instance-a' },
      1_000,
    );
    expect(volume.identity).toMatch(/^[a-f0-9]{64}$/);
    await expect(podman.resolveVolumeDataPathExact(volume, 1_000)).resolves.toBe(
      '/storage/volumes/instance-a/_data',
    );
    await podman.removeVolumeExact(volume, 1_000);
    expect(commands.requests.at(-1)?.args).toEqual([
      'volume', 'rm', '--', 'agent-deck-instance-a-state',
    ]);
  });

  it('rejects a changed rootless volume data path before exposing it to the manager', async () => {
    const commands = new ScriptedCommands();
    const inspected = (mountpoint: string) => JSON.stringify([{
      Name: 'agent-deck-instance-a-state',
      Mountpoint: mountpoint,
      CreatedAt: '2026-01-01T00:00:00Z',
      Labels: { 'io.agent-deck.instance': 'instance-a' },
    }]);
    commands.results.push(
      ok('{"host":{"security":{"rootless":true}}}'),
      ok(),
      ok(inspected('/storage/volumes/instance-a/_data')),
      ok(),
      ok(inspected('/storage/volumes/replaced/_data')),
    );
    const podman = new RootlessPodmanCommandPort(commands);
    const volume = await podman.inspectVolume('agent-deck-instance-a-state', 1_000);
    if (!volume) throw new Error('missing volume fixture');
    await expect(podman.resolveVolumeDataPathExact(volume, 1_000)).rejects.toMatchObject({
      code: 'identity_changed',
    });
  });

  it('rejects control characters in a Podman volume data path', async () => {
    const commands = new ScriptedCommands();
    commands.results.push(
      ok('{"host":{"security":{"rootless":true}}}'),
      ok(),
      ok(JSON.stringify([{
        Name: 'agent-deck-instance-a-state',
        Mountpoint: '/storage/volumes/instance-a\nreplaced/_data',
        CreatedAt: '2026-01-01T00:00:00Z',
        Labels: { 'io.agent-deck.instance': 'instance-a' },
      }])),
    );
    const podman = new RootlessPodmanCommandPort(commands);
    await expect(podman.inspectVolume(
      'agent-deck-instance-a-state',
      1_000,
    )).rejects.toMatchObject({ code: 'output_invalid' });
  });
});
