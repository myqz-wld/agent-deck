import { describe, expect, it, vi } from 'vitest';

import type { ServerConnectionService } from './connection-service';
import type { FeishuControlService } from './feishu-control-service';
import {
  runServerControlEntrypoint,
  serverControlEntrypointFailure,
} from './entrypoint';

const config = {
  schemaVersion: 2,
  appVersion: '0.1.0',
  instanceId: 'instance-a',
  topology: 'full',
  authorityFile: '/var/lib/agent-deck/authority.json',
  authorizedKeysFile: '/var/lib/agent-deck/authorized_keys',
  endpoint: {
    hostname: 'full.example.test',
    port: 22,
    username: 'agentdeck',
    hostKeyFile: '/etc/ssh/ssh_host_ed25519_key.pub',
  },
  relayRuntimeUid: null,
  feishuIdentityOwner: { uid: 1002, gid: 1002 },
};

describe('Server control entrypoint', () => {
  it('shows Simplified Chinese help without reading protected state', async () => {
    const write = vi.fn();
    await expect(runServerControlEntrypoint(['--help'], {
      uid: 501,
      readJson: vi.fn(),
      createConnectionService: vi.fn(),
      createFeishuService: vi.fn(),
      write,
    })).resolves.toBe(0);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('连接管理'));
    expect(write).toHaveBeenCalledWith(expect.stringContaining('feishu pair approve'));
    expect(write).toHaveBeenCalledWith(expect.stringContaining('feishu dry-run'));
  });

  it('requires root and emits only redacted structured failures', async () => {
    await expect(runServerControlEntrypoint([
      'connections', 'list', '--config', '/private/control.json',
    ], {
      uid: 501,
      readJson: vi.fn(),
      createConnectionService: vi.fn(),
      createFeishuService: vi.fn(),
      write: vi.fn(),
    })).rejects.toThrow('requires root');
    expect(serverControlEntrypointFailure()).toBe(
      '{"schemaVersion":1,"ok":false,"code":"operation_failed",' +
      '"message":"Server 连接管理操作失败；详细输入已隐藏。"}',
    );
  });

  it('routes one exact list command and prints no private fields', async () => {
    const write = vi.fn();
    const list = vi.fn(() => ({ topology: 'full', instanceId: 'instance-a', credentials: [] }));
    await expect(runServerControlEntrypoint([
      'connections', 'list', '--config', '/private/control.json',
    ], {
      uid: 0,
      readJson: vi.fn(async () => config),
      createConnectionService: vi.fn(() => ({ list } as unknown as ServerConnectionService)),
      createFeishuService: vi.fn(),
      write,
    })).resolves.toBe(0);
    expect(list).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"ok": true'));
    expect(JSON.stringify(write.mock.calls)).not.toContain('privateKey');
  });

  it('routes Feishu connect from two protected JSON files without accepting a secret in argv', async () => {
    const write = vi.fn();
    const connect = vi.fn(async () => ({ status: 'connected', credentialId: 'feishu-a' }));
    const request = {
      schemaVersion: 1,
      appId: 'cli_0123456789abcdef',
      tenantKey: 'tenant_1',
      credentialId: 'feishu-a',
      label: 'Production Feishu',
      appSecretFile: '/private/app-secret',
    };
    await expect(runServerControlEntrypoint([
      'feishu', 'connect', '--config', '/private/control.json',
      '--request', '/private/feishu-connect.json',
    ], {
      uid: 0,
      readJson: vi.fn(async (path) => path.endsWith('control.json') ? config : request),
      createConnectionService: vi.fn(),
      createFeishuService: vi.fn(() => ({ connect } as unknown as FeishuControlService)),
      write,
    })).resolves.toBe(0);
    expect(connect).toHaveBeenCalledWith(request);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"command": "feishu connect"'));
  });

  it('routes a non-mutating Feishu dry-run through the same protected request contract', async () => {
    const write = vi.fn();
    const dryRun = vi.fn(() => ({ status: 'ready-to-connect' }));
    const request = {
      schemaVersion: 1,
      appId: 'cli_0123456789abcdef',
      tenantKey: 'tenant_1',
      credentialId: 'feishu-a',
      label: 'Production Feishu',
      appSecretFile: '/private/app-secret',
    };
    await expect(runServerControlEntrypoint([
      'feishu', 'dry-run', '--config', '/private/control.json',
      '--request', '/private/feishu-connect.json',
    ], {
      uid: 0,
      readJson: vi.fn(async (path) => path.endsWith('control.json') ? config : request),
      createConnectionService: vi.fn(),
      createFeishuService: vi.fn(() => ({ dryRun } as unknown as FeishuControlService)),
      write,
    })).resolves.toBe(0);
    expect(dryRun).toHaveBeenCalledWith(request);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"command": "feishu dry-run"'));
  });
});
