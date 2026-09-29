import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RelayMetadataStore } from '@hosts/relay/metadata';
import { RelayMetadataFileService } from '@hosts/relay/metadata-file';
import { encodeRelayCredentialAuthority, parseRelayCredentialAuthority } from '@hosts/relay/credential-authority';
import type { ServerControlConfig } from './config';
import { recoverFeishuAuthority } from './feishu-authority-repair';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(kind: 'feishu' | 'relay-worker' = 'feishu', instanceId = 'instance-a') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'feishu-history-')));
  roots.push(root);
  const uid = process.getuid!();
  const worker = {
    id: 'worker-a', credentialId: 'worker-a', instanceId,
    kind: 'relay-worker' as const, status: 'active' as const, createdAt: 1, revokedAt: null,
    publicKey: 'ssh-ed25519 AAAATEST worker', fingerprint: 'SHA256:worker',
  };
  const orphan = {
    ...worker, id: 'failed-feishu', credentialId: 'failed-feishu', kind,
    publicKey: 'ssh-ed25519 AAAAFEISHU failed', fingerprint: 'SHA256:feishu',
  };
  const authorityFile = join(root, 'authority.json');
  const authorizedKeysFile = join(root, 'authorized_keys');
  writeFileSync(authorityFile, encodeRelayCredentialAuthority(instanceId, [worker]), { mode: 0o600 });
  writeFileSync(authorizedKeysFile, 'unrelated worker SSH entry\n', { mode: 0o600 });
  const metadata = new RelayMetadataStore();
  metadata.put('instances', { id: instanceId, instanceId, topology: 'relay', createdAt: 1 });
  metadata.put('credentials', { ...worker, status: 'revoked', revokedAt: 2 });
  metadata.put('credentials', orphan);
  const metadataFile = join(root, 'metadata.json');
  writeFileSync(metadataFile, metadata.exportSnapshot(), { mode: 0o600 });
  const config: ServerControlConfig = {
    schemaVersion: 2, appVersion: '0.1.0', topology: 'relay', instanceId: 'instance-a',
    authorityFile, authorizedKeysFile, relayRuntimeUid: uid,
    endpoint: { hostname: 'relay.example.test', port: 22, username: 'agentdeck', hostKeyFile: join(root, 'host-key') },
    feishuIdentityOwner: { uid, gid: process.getgid!() },
  };
  return { root, config, metadataFile, worker, orphan };
}

describe('legacy failed Feishu enrollment recovery', () => {
  it('restores only revoked public history and permits a strict Relay restart', async () => {
    const test = fixture();
    const originalMetadata = readFileSync(test.metadataFile, 'utf8');
    const originalKeys = readFileSync(test.config.authorizedKeysFile, 'utf8');
    await expect(RelayMetadataFileService.open({
      stateFile: test.metadataFile, instanceId: test.config.instanceId, credentials: [test.worker],
    })).rejects.toThrow('absent from authoritative config');
    expect(recoverFeishuAuthority(test.config, test.metadataFile)).toEqual({ status: 'recovered', restoredRevocations: 1 });
    const authority = parseRelayCredentialAuthority(JSON.parse(readFileSync(test.config.authorityFile, 'utf8')));
    expect(authority.credentials[0]).toEqual(test.worker);
    expect(authority.credentials[1]).toMatchObject({ ...test.orphan, status: 'revoked', revokedAt: expect.any(Number) });
    const reopened = await RelayMetadataFileService.open({
      stateFile: test.metadataFile, instanceId: test.config.instanceId, credentials: authority.credentials,
    });
    expect(reopened.metadata.getById('credentials', 'worker-a')?.status).toBe('active');
    expect(reopened.metadata.getById('credentials', 'failed-feishu')?.status).toBe('revoked');
    expect(readFileSync(test.metadataFile, 'utf8')).toBe(originalMetadata);
    expect(readFileSync(test.config.authorizedKeysFile, 'utf8')).toBe(originalKeys);
    expect(recoverFeishuAuthority(test.config, test.metadataFile).restoredRevocations).toBe(0);
  });

  it('rejects foreign-instance or non-Feishu history without writing authority', () => {
    for (const test of [fixture('relay-worker'), fixture('feishu', 'foreign-instance')]) {
      const original = readFileSync(test.config.authorityFile, 'utf8');
      expect(() => recoverFeishuAuthority(test.config, test.metadataFile)).toThrow();
      expect(readFileSync(test.config.authorityFile, 'utf8')).toBe(original);
    }
  });

  it('rejects unsafe metadata permissions, symlinks and owner mismatches', () => {
    const test = fixture();
    chmodSync(test.metadataFile, 0o644);
    expect(() => recoverFeishuAuthority(test.config, test.metadataFile)).toThrow('owner/mode');
    chmodSync(test.metadataFile, 0o600);
    expect(() => recoverFeishuAuthority({ ...test.config, relayRuntimeUid: test.config.relayRuntimeUid! + 1 }, test.metadataFile)).toThrow('owner/mode');
    const link = join(test.root, 'link.json');
    symlinkSync(test.metadataFile, link);
    expect(() => recoverFeishuAuthority(test.config, link)).toThrow('canonical');
  });
});
