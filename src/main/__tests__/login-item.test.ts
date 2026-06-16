import { describe, expect, it, vi } from 'vitest';

import {
  type LoginItemApp,
  shouldUpdateLoginItem,
  syncLoginItemSetting,
} from '../login-item';

function loginItem(partial: Partial<Electron.LoginItemSettings>): Electron.LoginItemSettings {
  return {
    openAtLogin: false,
    openAsHidden: false,
    wasOpenedAtLogin: false,
    wasOpenedAsHidden: false,
    restoreState: false,
    status: 'not-registered',
    executableWillLaunchAtLogin: false,
    launchItems: [],
    ...partial,
  };
}

function fakeApp(current: Electron.LoginItemSettings): {
  app: LoginItemApp;
  getLoginItemSettings: ReturnType<typeof vi.fn>;
  setLoginItemSettings: ReturnType<typeof vi.fn>;
} {
  const getLoginItemSettings = vi.fn(() => current);
  const setLoginItemSettings = vi.fn();
  return {
    app: {
      getLoginItemSettings,
      setLoginItemSettings,
    },
    getLoginItemSettings,
    setLoginItemSettings,
  };
}

describe('login item sync', () => {
  it('skips unsupported platforms', () => {
    const { app, getLoginItemSettings, setLoginItemSettings } = fakeApp(loginItem({}));
    const result = syncLoginItemSetting(true, { app, dev: false, platform: 'linux' });

    expect(result).toBe('unsupported');
    expect(getLoginItemSettings).not.toHaveBeenCalled();
    expect(setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('skips dev mode before reading OS login item state', () => {
    const { app, getLoginItemSettings, setLoginItemSettings } = fakeApp(loginItem({}));
    const result = syncLoginItemSetting(true, { app, dev: true, platform: 'darwin' });

    expect(result).toBe('dev-skipped');
    expect(getLoginItemSettings).not.toHaveBeenCalled();
    expect(setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('does not rewrite macOS login item when already enabled', () => {
    const { app, getLoginItemSettings, setLoginItemSettings } = fakeApp(
      loginItem({ openAtLogin: true, status: 'enabled' }),
    );
    const result = syncLoginItemSetting(true, { app, dev: false, platform: 'darwin' });

    expect(result).toBe('already-current');
    expect(getLoginItemSettings).toHaveBeenCalledWith({ type: 'mainAppService' });
    expect(setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('does not rewrite macOS login item while waiting for user approval', () => {
    const { app, setLoginItemSettings } = fakeApp(
      loginItem({ openAtLogin: false, status: 'requires-approval' }),
    );
    const result = syncLoginItemSetting(true, { app, dev: false, platform: 'darwin' });

    expect(result).toBe('already-current');
    expect(setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('registers macOS main app service when startOnLogin is enabled and not registered', () => {
    const { app, setLoginItemSettings } = fakeApp(
      loginItem({ openAtLogin: false, status: 'not-registered' }),
    );
    const result = syncLoginItemSetting(true, { app, dev: false, platform: 'darwin' });

    expect(result).toBe('updated');
    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      type: 'mainAppService',
    });
  });

  it('trusts macOS not-found status over a stale openAtLogin boolean', () => {
    const { app, setLoginItemSettings } = fakeApp(
      loginItem({ openAtLogin: true, status: 'not-found' }),
    );
    const result = syncLoginItemSetting(true, { app, dev: false, platform: 'darwin' });

    expect(result).toBe('updated');
    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      type: 'mainAppService',
    });
  });

  it('unregisters macOS login item when startOnLogin is disabled', () => {
    const { app, setLoginItemSettings } = fakeApp(
      loginItem({ openAtLogin: true, status: 'enabled' }),
    );
    const result = syncLoginItemSetting(false, { app, dev: false, platform: 'darwin' });

    expect(result).toBe('updated');
    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: false,
      type: 'mainAppService',
    });
  });

  it('keeps Windows comparison based on openAtLogin', () => {
    expect(shouldUpdateLoginItem(true, loginItem({ openAtLogin: false }), 'win32')).toBe(true);
    expect(shouldUpdateLoginItem(true, loginItem({ openAtLogin: true }), 'win32')).toBe(false);
  });
});
