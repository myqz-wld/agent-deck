import { describe, expect, it } from 'vitest';

import { parseFeishuCoreSshConfig } from './config';

function validConfig() {
  return {
    schemaVersion: 2,
    topology: 'full',
    instanceId: 'tenant-a',
    appVersion: '0.1.0',
    hostname: 'core.example.test',
    port: 22,
    username: 'agentdeck',
    knownHostsFile: '/etc/agent-deck/feishu/known_hosts',
    hostKeyAlias: 'agent-deck-core',
    credentials: [
      {
        credentialId: 'feishu-credential-a',
        connectionScope: 'scope-feishu-credential-a',
        identityFile: '/etc/agent-deck/feishu/credential-a.key',
      },
    ],
  };
}

describe('Feishu Core SSH config', () => {
  it('pins one exact topology, instance, host key, and credential identity set', () => {
    expect(parseFeishuCoreSshConfig(validConfig())).toEqual(validConfig());
    expect(() => parseFeishuCoreSshConfig({ ...validConfig(), extra: true })).toThrow(
      'missing or extra fields',
    );
    expect(() => parseFeishuCoreSshConfig({ ...validConfig(), instanceId: 'Tenant-A' })).toThrow(
      'lowercase Linux instance label',
    );
  });

  it('rejects retired schema and topology spellings', () => {
    const current = validConfig();
    const legacy = {
      ...current,
      schemaVersion: 1,
      topology: 'server-core',
      credentials: current.credentials.map(({ connectionScope: _scope, ...entry }) => entry),
    };

    expect(() => parseFeishuCoreSshConfig(legacy)).toThrow('schemaVersion');
    expect(() => parseFeishuCoreSshConfig({ ...legacy, topology: 'full' })).toThrow(
      'schemaVersion',
    );
    expect(() => parseFeishuCoreSshConfig({
      ...current,
      topology: 'server-core',
    })).toThrow('topology');
  });

  it('rejects ambiguous identities and unsafe OpenSSH profile values', () => {
    const duplicate = validConfig();
    duplicate.credentials.push({ ...duplicate.credentials[0] });
    expect(() => parseFeishuCoreSshConfig(duplicate)).toThrow('duplicates');
    expect(() => parseFeishuCoreSshConfig({ ...validConfig(), hostname: '-proxy' })).toThrow();
    expect(() => parseFeishuCoreSshConfig({
      ...validConfig(),
      knownHostsFile: 'relative-known-hosts',
    })).toThrow('absolute path');
  });
});
