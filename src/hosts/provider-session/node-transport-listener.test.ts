import { createConnection } from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createProviderSessionTransportListener } from './node-transport-listener';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Provider supervisor transport listener', () => {
  it.runIf(process.platform === 'linux')(
    'binds a long Linux volume path through an identity-pinned directory descriptor', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'ad-provider-listener-')));
    roots.push(root);
    const privateRoot = join(root, 'a'.repeat(80));
    const runtimeDirectory = join(privateRoot, 'supervisor');
    const socketPath = join(runtimeDirectory, 's.sock');
    const shortRoot = join(root, 'short');
    mkdirSync(privateRoot, { mode: 0o700 });
    symlinkSync(privateRoot, shortRoot);
    expect(Buffer.byteLength(socketPath)).toBeGreaterThan(103);
    const listener = createProviderSessionTransportListener({
      platform: 'linux',
      privateRoot,
      runtimeDirectory,
      socketPath,
    });
    let accepted = false;
    await listener.start((stream) => {
      accepted = true;
      stream.end();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(join(shortRoot, 'supervisor', 's.sock'));
        socket.once('connect', () => {
          socket.end();
          resolve();
        });
        socket.once('error', reject);
      });
      expect(accepted).toBe(true);
    } finally {
      await listener.stop();
    }
    },
  );

  it('fails closed for a long non-Linux path', () => {
    expect(() => createProviderSessionTransportListener({
      platform: 'darwin',
      privateRoot: `/private/tmp/${'a'.repeat(80)}`,
      runtimeDirectory: `/private/tmp/${'a'.repeat(80)}/supervisor`,
      socketPath: `/private/tmp/${'a'.repeat(80)}/supervisor/s.sock`,
    })).toThrow('portable host bound');
  });
});
