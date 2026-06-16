import { app } from 'electron';
import log from '@main/utils/logger';

const logger = log.scope('login-item');

export interface LoginItemApp {
  getLoginItemSettings(options?: Electron.LoginItemSettingsOptions): Electron.LoginItemSettings;
  setLoginItemSettings(settings: Electron.Settings): void;
}

export type LoginItemSyncResult =
  | 'unsupported'
  | 'dev-skipped'
  | 'already-current'
  | 'updated';

const MAC_LOGIN_ITEM_OPTIONS = {
  type: 'mainAppService',
} satisfies Electron.LoginItemSettingsOptions;

function loginItemReadOptions(platform: NodeJS.Platform): Electron.LoginItemSettingsOptions | undefined {
  return platform === 'darwin' ? MAC_LOGIN_ITEM_OPTIONS : undefined;
}

function loginItemWriteSettings(
  openAtLogin: boolean,
  platform: NodeJS.Platform,
): Electron.Settings {
  if (platform === 'darwin') {
    return {
      openAtLogin,
      type: 'mainAppService',
    };
  }
  return { openAtLogin };
}

export function shouldUpdateLoginItem(
  openAtLogin: boolean,
  current: Electron.LoginItemSettings,
  platform: NodeJS.Platform,
): boolean {
  if (platform === 'darwin') {
    const status = current.status;
    if (openAtLogin) {
      if (status === 'enabled' || status === 'requires-approval') return false;
      if (status === 'not-registered' || status === 'not-found') return true;
      return !current.openAtLogin;
    }
    return status === 'enabled' || status === 'requires-approval' || current.openAtLogin;
  }
  return current.openAtLogin !== openAtLogin;
}

/**
 * Sync Agent Deck's login item setting with the OS, but avoid writing when the OS
 * already reflects the requested state. On macOS 13+, repeated writes while the
 * main app service is already enabled or waiting for approval can surface as
 * duplicate rows in System Settings > Login Items.
 */
export function syncLoginItemSetting(
  openAtLogin: boolean,
  opts: {
    app?: LoginItemApp;
    dev?: boolean;
    platform?: NodeJS.Platform;
  } = {},
): LoginItemSyncResult {
  const platform = opts.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'win32') return 'unsupported';
  if (opts.dev === true) return 'dev-skipped';

  const electronApp = opts.app ?? app;
  let current: Electron.LoginItemSettings | null = null;
  try {
    current = electronApp.getLoginItemSettings(loginItemReadOptions(platform));
  } catch (err) {
    logger.warn('[login-item] getLoginItemSettings failed; applying requested state anyway', err);
  }

  if (current && !shouldUpdateLoginItem(openAtLogin, current, platform)) {
    if (platform === 'darwin' && openAtLogin && current.status === 'requires-approval') {
      logger.warn('[login-item] startOnLogin is waiting for macOS approval; skip duplicate registration');
    }
    return 'already-current';
  }

  electronApp.setLoginItemSettings(loginItemWriteSettings(openAtLogin, platform));
  return 'updated';
}
