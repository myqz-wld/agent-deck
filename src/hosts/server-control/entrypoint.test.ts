import { describe, expect, it, vi } from 'vitest';

import type { ServerConnectionService } from './connection-service';
import {
  runServerControlEntrypoint,
  serverControlEntrypointFailure,
} from './entrypoint';

const config = {
  schemaVersion: 1,
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
      write,
    })).resolves.toBe(0);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('连接管理'));
  });

  it('requires root and emits only redacted structured failures', async () => {
    await expect(runServerControlEntrypoint([
      'connections', 'list', '--config', '/private/control.json',
    ], {
      uid: 501,
      readJson: vi.fn(),
      createConnectionService: vi.fn(),
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
      write,
    })).resolves.toBe(0);
    expect(list).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"ok": true'));
    expect(JSON.stringify(write.mock.calls)).not.toContain('privateKey');
  });
});
