import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { assessStorageBudget, DEPLOYMENT_FREE_RESERVE_BYTES } from './remote-storage-budget.mjs';
import { expandedGzipBytes } from './storage-budget.mjs';

const roots = [];
const MiB = 1024 * 1024;
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('deployment storage budgeting', () => {
  it('adds staging and runtime allocations on a shared filesystem while reserving headroom once', () => {
    const filesystem = { device: 'root', availableBytes: 450 * MiB };
    const result = assessStorageBudget({ staging: 150 * MiB, runtime: 130 * MiB, service: 0 }, {
      staging: filesystem, runtime: filesystem, service: filesystem,
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([{
      roles: ['staging', 'runtime', 'service'], availableBytes: 450 * MiB,
      requiredBytes: 280 * MiB + DEPLOYMENT_FREE_RESERVE_BYTES,
    }]);
  });

  it('rejects a full temporary filesystem even when the installation volume has ample space', () => {
    const result = assessStorageBudget({ staging: 150 * MiB, runtime: 130 * MiB }, {
      staging: { device: 'temporary', availableBytes: 10 * MiB },
      runtime: { device: 'root', availableBytes: 10_000 * MiB },
    });
    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(2);
  });

  it('accepts a release that fits including the reserve and rejects invalid byte counts', () => {
    expect(assessStorageBudget({ runtime: 130 * MiB }, {
      runtime: { device: 'root', availableBytes: 130 * MiB + DEPLOYMENT_FREE_RESERVE_BYTES },
    }).ok).toBe(true);
    for (const value of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER]) {
      expect(() => assessStorageBudget({ runtime: value }, {
        runtime: { device: 'root', availableBytes: 1000 * MiB },
      })).toThrow('disk budget');
    }
  });

  it('budgets expanded archive bytes rather than the small compressed upload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-deck-storage-budget-'));
    roots.push(root);
    const input = Buffer.alloc(8 * MiB, 0x61);
    const compressed = gzipSync(input);
    expect(compressed.byteLength).toBeLessThan(MiB);
    const archive = join(root, 'runtime.tgz');
    await writeFile(archive, compressed);
    expect(await expandedGzipBytes(archive)).toBe(input.byteLength);
    await writeFile(archive, 'invalid gzip');
    await expect(expandedGzipBytes(archive)).rejects.toThrow();
    await expect(expandedGzipBytes(join(root, 'missing.tgz'))).rejects.toThrow();
  });
});
