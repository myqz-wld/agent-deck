import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runRelayEntrypoint } from './entrypoint';

describe('Relay health entrypoint', () => {
  it('proves the private control socket is accepting connections', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-deck-relay-health-'));
    const socketPath = join(root, 'control.sock');
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.end();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      await expect(runRelayEntrypoint([
        'health',
        '--socket',
        socketPath,
      ])).resolves.toBe(0);
      expect(connections).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a non-absolute health socket before connecting', async () => {
    await expect(runRelayEntrypoint([
      'health',
      '--socket',
      'relative/control.sock',
    ])).rejects.toThrow('socket must be a normalized non-root absolute path');
  });
});
