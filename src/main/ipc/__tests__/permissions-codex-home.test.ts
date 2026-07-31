import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain, shell } from 'electron';
import { IpcInvoke } from '@shared/ipc-channels';

vi.mock('@main/permissions/scanner', () => ({
  scanCwdSettings: vi.fn(),
  getCandidatePaths: vi.fn(() => ({
    user: '/user',
    userLocal: '/user-local',
    project: '/project',
    local: '/local',
  })),
}));
vi.mock('@main/permissions/codex-scanner', () => ({ scanCodexSettings: vi.fn() }));
vi.mock('@main/store/session-repo', () => ({ sessionRepo: { get: vi.fn(() => null) } }));

import { registerPermissionsIpc } from '../permissions';

const originalCodexHome = process.env.CODEX_HOME;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CODEX_HOME = '/tmp/agent-deck-permissions-codex-home';
  registerPermissionsIpc();
});

afterEach(() => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
});

function handler(channel: string): (...args: unknown[]) => unknown {
  const registered = vi.mocked(ipcMain.handle).mock.calls.find(([name]) => name === channel)?.[1];
  expect(registered).toBeTypeOf('function');
  return registered as unknown as (...args: unknown[]) => unknown;
}

describe('Codex permission config opening', () => {
  it('opens only the active CODEX_HOME/config.toml path', async () => {
    vi.mocked(shell.openPath).mockResolvedValue('');
    const open = handler(IpcInvoke.PermissionOpenCodexFile);
    const expected = '/tmp/agent-deck-permissions-codex-home/config.toml';

    await expect(open({}, expected)).resolves.toEqual({ ok: true });
    await expect(open({}, '/Users/example/.codex/config.toml')).resolves.toEqual({
      ok: false,
      reason: 'path not in codex config path',
    });
    expect(shell.openPath).toHaveBeenCalledOnce();
    expect(shell.openPath).toHaveBeenCalledWith(expected);
  });
});
