import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FlockHostInstanceLeasePort } from './flock-lease';

const temporary: string[] = [];

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

function fakeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  });
  stdin.on('data', (chunk) => stdout.write(chunk));
  stdin.once('end', () => {
    Object.defineProperty(child, 'exitCode', { value: 0, configurable: true });
    child.emit('exit', 0, null);
  });
  return child;
}

describe('process-bound flock leases', () => {
  it('holds an exact non-expiring lock until its parent-owned pipe closes', async () => {
    const created = await mkdtemp(join(tmpdir(), 'agent-deck-lock-'));
    const root = await realpath(created);
    temporary.push(root);
    await mkdir(join(root, 'locks'), { mode: 0o700 });
    await chmod(join(root, 'locks'), 0o700);
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const leases = new FlockHostInstanceLeasePort({
      lockRoot: join(root, 'locks'),
      platform: 'linux',
      flockExecutable: '/usr/bin/flock',
      holderExecutable: '/usr/bin/cat',
      testOnlyDirectPaths: true,
    }, spawnProcess);
    const lock = await leases.acquire({
      key: 'relay:instance-a',
      ownerToken: 'owner-a',
      timeoutMs: 1_000,
    });

    expect(spawnProcess).toHaveBeenCalledWith('/usr/bin/flock', [
      '--exclusive', '--wait', '1.000', '--',
      '/proc/self/fd/3',
      '/usr/bin/cat',
    ], expect.objectContaining({ shell: false, stdio: ['pipe', 'pipe', 'pipe', expect.any(Number)] }));
    await expect(leases.release({ ...lock, ownerToken: 'other' }, 1_000))
      .rejects.toMatchObject({ code: 'lock_failed' });
    await expect(leases.release(lock, 1_000)).resolves.toBeUndefined();
  });
});
