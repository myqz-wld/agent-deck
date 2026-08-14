import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { RelayMetadataFileService } from './metadata-file';
import { RelayMetadataStore } from './metadata';

const temporary: string[] = [];

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});

const credentials = [{
  id: 'worker-credential',
  instanceId: 'instance-a',
  credentialId: 'worker-credential',
  kind: 'relay-worker' as const,
  publicKey: 'ssh-ed25519 AAAATEST relay-worker',
  fingerprint: 'SHA256:test',
  status: 'active' as const,
  createdAt: 1,
  revokedAt: null,
}];

describe('Relay metadata file service', () => {
  it('persists only the allowlisted metadata snapshot and restores authoritative credentials', async () => {
    const created = await mkdtemp(join(tmpdir(), 'agent-deck-relay-state-'));
    const root = await realpath(created);
    temporary.push(root);
    await chmod(root, 0o700);
    const stateFile = join(root, 'metadata.json');
    const service = await RelayMetadataFileService.open({
      stateFile,
      instanceId: 'instance-a',
      credentials,
    });
    await service.start();
    service.metadata.put('health', {
      id: 'relay',
      instanceId: 'instance-a',
      component: 'relay',
      status: 'ok',
      checkedAt: 2,
      detailCode: null,
    });
    await service.stop();

    const persisted = await readFile(stateFile, 'utf8');
    expect(persisted).toContain('worker-credential');
    for (const forbidden of ['messageBody', 'approvalInput', 'diff', 'sessionDatabase']) {
      expect(persisted).not.toContain(forbidden);
    }
    const reopened = await RelayMetadataFileService.open({
      stateFile,
      instanceId: 'instance-a',
      credentials,
    });
    expect(reopened.metadata.getById('health', 'relay')).toMatchObject({ status: 'ok' });
  });

  it('refuses persisted credential state outside the authoritative config', async () => {
    const created = await mkdtemp(join(tmpdir(), 'agent-deck-relay-state-'));
    const root = await realpath(created);
    temporary.push(root);
    await chmod(root, 0o700);
    const stateFile = join(root, 'metadata.json');
    const service = await RelayMetadataFileService.open({
      stateFile,
      instanceId: 'instance-a',
      credentials,
    });
    await service.start();
    await service.stop();
    await expect(RelayMetadataFileService.open({
      stateFile,
      instanceId: 'instance-a',
      credentials: [],
    })).rejects.toThrow('absent from authoritative config');
  });

  it('rejects a tampered restart snapshot containing any foreign-instance metadata', async () => {
    const created = await mkdtemp(join(tmpdir(), 'agent-deck-relay-state-'));
    const root = await realpath(created);
    temporary.push(root);
    await chmod(root, 0o700);
    const stateFile = join(root, 'metadata.json');
    const foreign = new RelayMetadataStore();
    foreign.put('instances', {
      id: 'foreign-instance', instanceId: 'foreign-instance', topology: 'relay', createdAt: 1,
    });
    foreign.put('credentials', {
      id: 'foreign-worker', instanceId: 'foreign-instance', credentialId: 'foreign-worker',
      kind: 'relay-worker', publicKey: 'ssh-ed25519 AAAATEST foreign-worker',
      fingerprint: 'SHA256:foreign-worker', status: 'active', createdAt: 1, revokedAt: null,
    });
    foreign.put('credentials', {
      id: 'foreign-client', instanceId: 'foreign-instance', credentialId: 'foreign-client',
      kind: 'ssh-client', publicKey: 'ssh-ed25519 AAAATEST foreign-client',
      fingerprint: 'SHA256:foreign-client', status: 'active', createdAt: 1, revokedAt: null,
    });
    foreign.put('credentials', {
      id: 'foreign-feishu', instanceId: 'foreign-instance', credentialId: 'foreign-feishu',
      kind: 'feishu', publicKey: null, fingerprint: 'SHA256:foreign-feishu',
      status: 'active', createdAt: 1, revokedAt: null,
    });
    foreign.put('workerRegistrations', {
      id: 'foreign-instance', instanceId: 'foreign-instance', workerId: 'foreign-worker-id',
      credentialId: 'foreign-worker', generation: 1, status: 'online',
      registeredAt: 1, lastSeenAt: 1,
    });
    foreign.put('routes', {
      id: 'foreign-route', instanceId: 'foreign-instance', routeId: 'foreign-route',
      accessCredentialId: 'foreign-client', accessSurface: 'desktop',
      workerId: 'foreign-worker-id', generation: 1,
      status: 'open', updatedAt: 1,
    });
    foreign.put('feishuContexts', {
      id: 'foreign-context', instanceId: 'foreign-instance', credentialId: 'foreign-feishu',
      openId: 'open-id', unionId: null, chatId: 'chat-id', activeSessionId: null, updatedAt: 1,
    });
    foreign.put('feishuSubscriptions', {
      id: 'foreign-subscription', instanceId: 'foreign-instance', credentialId: 'foreign-feishu',
      chatId: 'chat-id', sessionId: 'session-id', status: 'active', updatedAt: 1,
    });
    foreign.put('feishuDeliveries', {
      id: 'foreign-event', instanceId: 'foreign-instance', eventId: 'foreign-event',
      credentialId: 'foreign-feishu', chatId: 'chat-id', status: 'sent', attempts: 1, updatedAt: 1,
    });
    foreign.put('reconciliationCursors', {
      id: 'foreign-cursor', instanceId: 'foreign-instance', credentialId: 'foreign-feishu',
      chatId: 'chat-id', cursor: 'cursor-value', updatedAt: 1,
    });
    foreign.put('health', {
      id: 'relay', instanceId: 'foreign-instance', component: 'relay',
      status: 'ok', checkedAt: 1, detailCode: null,
    });
    await writeFile(stateFile, `${foreign.exportSnapshot()}\n`, { mode: 0o600 });

    await expect(RelayMetadataFileService.open({
      stateFile,
      instanceId: 'instance-a',
      credentials,
    })).rejects.toThrow('foreign instance');
  });

  it('revalidates exact foreign keys after authoritative credential replacement', async () => {
    const created = await mkdtemp(join(tmpdir(), 'agent-deck-relay-state-'));
    const root = await realpath(created);
    temporary.push(root);
    await chmod(root, 0o700);
    const stateFile = join(root, 'metadata.json');
    const stored = new RelayMetadataStore();
    stored.put('instances', {
      id: 'instance-a', instanceId: 'instance-a', topology: 'relay', createdAt: 1,
    });
    stored.put('credentials', {
      id: 'shared-credential', instanceId: 'instance-a', credentialId: 'shared-credential',
      kind: 'feishu', publicKey: null, fingerprint: 'SHA256:shared',
      status: 'active', createdAt: 1, revokedAt: null,
    });
    stored.put('feishuContexts', {
      id: 'context-a', instanceId: 'instance-a', credentialId: 'shared-credential',
      openId: 'open-id', unionId: null, chatId: 'chat-id', activeSessionId: null, updatedAt: 1,
    });
    await writeFile(stateFile, `${stored.exportSnapshot()}\n`, { mode: 0o600 });

    await expect(RelayMetadataFileService.open({
      stateFile,
      instanceId: 'instance-a',
      credentials: [{
        id: 'shared-credential', instanceId: 'instance-a',
        credentialId: 'shared-credential', kind: 'relay-worker',
        publicKey: 'ssh-ed25519 AAAATEST shared', fingerprint: 'SHA256:shared',
        status: 'active', createdAt: 1, revokedAt: null,
      }],
    })).rejects.toThrow('Invalid credential foreign key');
  });

  it('fails startup instead of serving when its metadata target is unsafe', async () => {
    const created = await mkdtemp(join(tmpdir(), 'agent-deck-relay-state-'));
    const root = await realpath(created);
    temporary.push(root);
    await chmod(root, 0o700);
    const stateFile = join(root, 'metadata.json');
    const service = await RelayMetadataFileService.open({
      stateFile,
      instanceId: 'instance-a',
      credentials,
    });
    await symlink(join(root, 'redirected'), stateFile);
    await expect(service.start()).rejects.toThrow('state file target is unsafe');
    expect(service.failure).not.toBeNull();
  });
});
