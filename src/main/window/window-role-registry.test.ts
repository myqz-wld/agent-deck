import { describe, expect, it, vi } from 'vitest';

import { WindowRoleRegistry } from './window-role-registry';

describe('explicit BrowserWindow role registry', () => {
  it('never treats the parking host as a user presentation window', () => {
    const registry = new WindowRoleRegistry<object>();
    const parking = {};
    const floating = {};

    registry.register(parking, 'browser-parking');
    expect(registry.hasUserWindow()).toBe(false);
    expect(registry.currentUserWindow()).toBeNull();
    registry.register(floating, 'floating');
    expect(registry.hasUserWindow()).toBe(true);
    expect(registry.currentUserWindow()).toBe(floating);
  });

  it('emits the last-user-window transition once while internal windows remain alive', () => {
    const registry = new WindowRoleRegistry<object>();
    const listener = vi.fn();
    registry.onUserWindowsEmpty(listener);
    const unregisterParking = registry.register({}, 'browser-parking');
    const unregisterFloating = registry.register({}, 'floating');

    unregisterFloating();
    unregisterFloating();
    expect(listener).toHaveBeenCalledOnce();
    expect(registry.hasUserWindow()).toBe(false);
    unregisterParking();
    expect(listener).toHaveBeenCalledOnce();
  });
});
