import type { BrowserWindow } from 'electron';

export type WindowRole = 'floating' | 'browser-parking';

const USER_ROLES = new Set<WindowRole>(['floating']);

/** Tracks presentation intent independently of Electron's global BrowserWindow enumeration. */
export class WindowRoleRegistry<Window extends object> {
  private readonly roles = new Map<Window, WindowRole>();
  private readonly emptyListeners = new Set<() => void>();

  register(window: Window, role: WindowRole): () => void {
    this.roles.set(window, role);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const before = this.hasUserWindow();
      this.roles.delete(window);
      if (before && !this.hasUserWindow()) {
        for (const listener of [...this.emptyListeners]) listener();
      }
    };
  }

  hasUserWindow(): boolean {
    for (const role of this.roles.values()) {
      if (USER_ROLES.has(role)) return true;
    }
    return false;
  }

  currentUserWindow(): Window | null {
    let current: Window | null = null;
    for (const [window, role] of this.roles) {
      if (USER_ROLES.has(role)) current = window;
    }
    return current;
  }

  onUserWindowsEmpty(listener: () => void): () => void {
    this.emptyListeners.add(listener);
    return () => this.emptyListeners.delete(listener);
  }
}

const windowRoles = new WindowRoleRegistry<BrowserWindow>();

export function registerWindowRole(window: BrowserWindow, role: WindowRole): () => void {
  return windowRoles.register(window, role);
}

export function currentUserWindow(): BrowserWindow | null {
  return windowRoles.currentUserWindow();
}

export function hasUserWindow(): boolean {
  return windowRoles.hasUserWindow();
}

export function onUserWindowsEmpty(listener: () => void): () => void {
  return windowRoles.onUserWindowsEmpty(listener);
}
