import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { RelayHeadlessConfig } from './headless-config';
import { createRelayController } from './headless-root';

const temporary: string[] = [];

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('Relay headless root', () => {
  it('starts only metadata/routing plumbing and a mode-0600 private control socket', async () => {
    const created = await mkdtemp('/tmp/ad-relay-');
    const root = await realpath(created);
    temporary.push(root);
    const state = join(root, 'state', 'instance-a');
    const socket = join(root, 'run', 'instance-a', 'control.sock');
    const authorityFile = join(root, 'authority.json');
    await mkdir(state, { recursive: true, mode: 0o700 });
    await chmod(state, 0o700);
    const config: RelayHeadlessConfig = {
      schemaVersion: 2,
      instanceId: 'instance-a',
      tickIntervalMs: 1_000,
      plumbingModule: null,
      authorityFile,
    };
    await writeFile(authorityFile, `${JSON.stringify({
      schemaVersion: 1,
      instanceId: 'instance-a',
      credentials: [],
    })}\n`, { mode: 0o600 });
    const controller = await createRelayController(config, {
      stateDirectory: state,
      controlSocket: socket,
    });

    expect(controller.composition.role).toBe('relay-server');
    expect(controller.composition.components.map((component) => component.name)).toEqual([
      'relay-metadata-file',
      'relay-credential-authority',
      'relay-worker-lease-ticker',
      'relay-control-socket',
    ]);
    await controller.start();
    const identity = await lstat(socket);
    expect(identity.isSocket()).toBe(true);
    expect(identity.mode & 0o777).toBe(0o600);
    await controller.stop('test-complete');
    await expect(lstat(socket)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
