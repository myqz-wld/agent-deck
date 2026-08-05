import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { AtomicPrivateStateFile } from '@hosts/linux-runtime/atomic-state-file';

import { LocalWorkerGenerationStore } from './generation-store';

const temporary: string[] = [];

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('Local Worker generation store', () => {
  it('durably fences the exact instance and Worker identity', async () => {
    const created = await mkdtemp(join(tmpdir(), 'agent-deck-worker-state-'));
    const root = await realpath(created);
    temporary.push(root);
    await chmod(root, 0o700);
    const file = join(root, 'generation.json');
    const store = new LocalWorkerGenerationStore(
      new AtomicPrivateStateFile(file, 4_096),
      'instance-a',
      'worker-a',
    );
    expect(await store.load()).toBeNull();
    await store.start();
    await store.record(7);
    await store.stop();

    await expect(new LocalWorkerGenerationStore(
      new AtomicPrivateStateFile(file, 4_096),
      'instance-a',
      'worker-a',
    ).load()).resolves.toBe(7);
    await expect(new LocalWorkerGenerationStore(
      new AtomicPrivateStateFile(file, 4_096),
      'instance-a',
      'worker-b',
    ).load()).rejects.toThrow('does not match this Worker');
  });
});
