import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IpcInvoke } from '@shared/ipc-channels';

const getLastErrors = vi.hoisted(() => vi.fn());

vi.mock('@main/session/summarizer/desktop', () => ({
  summarizer: { getLastErrors },
}));

import { registerDiagnosticsIpc } from '../diagnostics';

describe('diagnostics IPC', () => {
  beforeEach(() => {
    getLastErrors.mockReset().mockReturnValue({ 'session-a': { message: 'failed', ts: 7 } });
    vi.mocked(ipcMain.handle).mockClear();
    registerDiagnosticsIpc();
  });

  it('preserves bounded summarizer diagnostics after Team IPC removal', () => {
    const handler = vi.mocked(ipcMain.handle).mock.calls.find(
      ([channel]) => channel === IpcInvoke.SummarizerLastErrors,
    )?.[1];
    expect(handler).toBeTypeOf('function');
    expect(handler!({} as never)).toEqual({ 'session-a': { message: 'failed', ts: 7 } });
  });
});
