import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { NodeProviderSessionAttachmentProcess } from './node-oci-attachment';

const spawnTestNodeChild = ((
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => spawn(executable, [...args], {
  ...options,
  env: {
    ...options.env,
    // The authoritative suite itself runs under Electron-as-Node. Preserve that
    // test-harness mode without admitting this variable to the production env.
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  },
})) as typeof spawn;

function request(overrides: Record<string, unknown> = {}) {
  return {
    args: [
      '-e',
      "process.stderr.write('host-only-diagnostic'); process.stdin.pipe(process.stdout)",
      'provider-attach',
    ],
    environment: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
    executable: process.execPath,
    startupTimeoutMs: 2_000,
    ...overrides,
  };
}

describe('NodeProviderSessionAttachmentProcess', () => {
  it('opens one shell-free backpressured stdio stream and retires only its child', async () => {
    const runner = new NodeProviderSessionAttachmentProcess({
      finalExitWaitMs: 500,
      terminateGraceMs: 500,
    }, spawnTestNodeChild);
    const attachment = await runner.open(request());
    const output = new Promise<string>((resolve, reject) => {
      attachment.stream.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')));
      attachment.stream.once('error', reject);
    });
    attachment.stream.write(Buffer.from('ACP frame\n'));
    await expect(output).resolves.toBe('ACP frame\n');
    await attachment.close();
    await expect(attachment.exited).resolves.toMatchObject({ code: 0, signal: null });
  });

  it('rejects inherited loader or credential environment before process creation', async () => {
    const runner = new NodeProviderSessionAttachmentProcess();
    await expect(runner.open(request({
      environment: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin', XAI_API_KEY: 'secret' },
    }))).rejects.toThrow('environment');
    await expect(runner.open(request({
      environment: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin', NODE_OPTIONS: '--inspect' },
    }))).rejects.toThrow('environment');
  });
});
