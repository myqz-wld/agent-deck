import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ProviderSessionSupervisorTransportClient } from './supervisor-transport-client';
import { createProductionProviderSessionSupervisorHost } from './production';
import type {
  ProviderSessionProcessPort,
  ProviderSessionProcessRequest,
} from './node-oci-process';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('production Provider supervisor host composition', () => {
  it('keeps OCI authority host-side behind the private Core transport', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'ad-prod-')));
    roots.push(root);
    const workspaceRoot = join(root, 'workspace');
    const privateRoot = join(root, 'private');
    const stateRoot = join(privateRoot, 'state');
    const brokerRoot = join(privateRoot, 'broker');
    const transportRoot = root;
    for (const path of [workspaceRoot, privateRoot, stateRoot, brokerRoot]) {
      mkdirSync(path, { mode: 0o700 });
    }
    const executable = join(root, 'podman');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    chmodSync(executable, 0o700);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    const calls: ProviderSessionProcessRequest[] = [];
    const runner: ProviderSessionProcessPort = {
      run: async (request) => {
        calls.push(request);
        if (request.args.slice(0, 3).join(' ') === 'container ls --all') {
          return {
            exitCode: 0,
            outputTruncated: false,
            stderr: '',
            stdout: '',
            timedOut: false,
          };
        }
        return {
          exitCode: 0,
          outputTruncated: false,
          stderr: '',
          stdout: JSON.stringify({ host: { security: { rootless: true } } }),
          timedOut: false,
        };
      },
    };
    const socketPath = join(transportRoot, 's.sock');
    const host = createProductionProviderSessionSupervisorHost({
      brokerRoot,
      coreProcessId: 'core-a',
      currentUid: () => uid,
      engine: 'rootless-podman',
      executable,
      images: {
        'claude-code-v1': null,
        'codex-cli-v1': null,
        'grok-build-v1': `registry.invalid/grok@sha256:${'a'.repeat(64)}`,
      },
      instanceId: 'instance-a',
      platform: 'linux',
      privateRoot,
      process: runner,
      rootlessHome: root,
      rootlessRuntimeDirectory: `/run/user/${uid}`,
      stateRoot,
      transportRuntimeDirectory: transportRoot,
      transportSocketPath: socketPath,
      workspaceRoot,
    });
    await host.start();
    try {
      const client = new ProviderSessionSupervisorTransportClient({ socketPath });
      await expect(client.capabilities()).resolves.toMatchObject({
        adapterIds: ['grok-build'],
        available: true,
      });
      expect(calls[0]!.environment).toMatchObject({ HOME: root });
      expect(calls[0]!.args.slice(0, 3)).toEqual(['container', 'ls', '--all']);
      expect(JSON.stringify(calls)).not.toMatch(/image|mount|credential|auth|workspace/i);
    } finally {
      await host.stop();
    }
  });
});
