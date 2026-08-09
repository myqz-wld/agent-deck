import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertFeishuCoreSshTrustFiles,
  readFeishuCoreSshConfig,
} from './trusted-files';

const roots: string[] = [];

async function privateFile(root: string, name: string, value: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, value, { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Feishu trusted SSH files', () => {
  it('reads an exact private Core config and verifies pinned key material', async () => {
    const createdRoot = await mkdtemp(join(tmpdir(), 'agent-deck-feishu-'));
    roots.push(createdRoot);
    const root = await realpath(createdRoot);
    const knownHostsFile = await privateFile(root, 'known_hosts', 'host ssh-ed25519 AAAA\n');
    const identityFile = await privateFile(root, 'identity', 'PRIVATE-KEY-FIXTURE\n');
    const configPath = await privateFile(root, 'core.json', JSON.stringify({
      schemaVersion: 1,
      topology: 'relay',
      instanceId: 'tenant-a',
      appVersion: '0.1.0',
      hostname: 'relay.example.test',
      port: 22,
      username: 'agentdeck',
      knownHostsFile,
      hostKeyAlias: null,
      credentials: [{ credentialId: 'feishu-a', identityFile }],
    }));
    const config = await readFeishuCoreSshConfig(configPath);
    expect(config.instanceId).toBe('tenant-a');
    await expect(assertFeishuCoreSshTrustFiles(config)).resolves.toBeUndefined();
  });

  it('rejects a group/world-readable config or identity', async () => {
    const createdRoot = await mkdtemp(join(tmpdir(), 'agent-deck-feishu-'));
    roots.push(createdRoot);
    const root = await realpath(createdRoot);
    const configPath = await privateFile(root, 'core.json', '{}');
    await chmod(configPath, 0o644);
    await expect(readFeishuCoreSshConfig(configPath)).rejects.toThrow('private file');

    const knownHostsFile = await privateFile(root, 'known_hosts', 'known host');
    const identityFile = await privateFile(root, 'identity', 'private key');
    await chmod(identityFile, 0o644);
    await expect(assertFeishuCoreSshTrustFiles({
      schemaVersion: 1,
      topology: 'relay',
      instanceId: 'tenant-a',
      appVersion: '0.1.0',
      hostname: 'relay.example.test',
      port: 22,
      username: 'agentdeck',
      knownHostsFile,
      hostKeyAlias: null,
      credentials: [{ credentialId: 'feishu-a', identityFile }],
    })).rejects.toThrow('private file');
  });
});
