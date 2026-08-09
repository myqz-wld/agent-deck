import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  install: vi.fn(),
  setName: vi.fn(() => mocks.calls.push('setName')),
  getAppPath: vi.fn(() => {
    mocks.calls.push('getAppPath');
    return '/opt/agent-deck/app';
  }),
  getPath: vi.fn(() => {
    mocks.calls.push('getPath');
    return '/var/lib/agent-deck/desktop';
  }),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    setName: mocks.setName,
    getAppPath: mocks.getAppPath,
    getPath: mocks.getPath,
  },
}));

vi.mock('@main/runtime-host/application-paths', () => ({
  installApplicationHostPaths: mocks.install,
}));

describe('Electron application path host', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.calls.length = 0;
    mocks.install.mockReset();
  });

  it('sets the application identity before capturing exact host paths', async () => {
    await import('../electron-application-paths');

    expect(mocks.calls).toEqual(['setName', 'getAppPath', 'getPath']);
    expect(mocks.setName).toHaveBeenCalledWith('Agent Deck');
    expect(mocks.getPath).toHaveBeenCalledWith('userData');
    expect(mocks.install).toHaveBeenCalledWith({
      isPackaged: true,
      appPath: '/opt/agent-deck/app',
      resourcesPath: process.resourcesPath,
      userDataPath: '/var/lib/agent-deck/desktop',
    });
  });
});
