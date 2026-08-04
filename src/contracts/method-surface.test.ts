import { describe, expect, it } from 'vitest';

import { AccessSurface } from './access';
import { CORE_METHOD_METADATA } from './methods';
import { coreMethodsForSurface, isCoreMethodAllowed } from './method-surface';

describe('fixed Core transport surfaces', () => {
  it('exposes every initial Core method to an enrolled SSH desktop', () => {
    expect([...coreMethodsForSurface(AccessSurface.DesktopFull)].sort()).toEqual(
      Object.keys(CORE_METHOD_METADATA).sort(),
    );
  });

  it('exposes only explicitly classified session-console methods to Feishu', () => {
    const allowed = coreMethodsForSurface(AccessSurface.FeishuSessionConsole);

    expect(allowed.length).toBeGreaterThan(0);
    for (const method of allowed) {
      expect(CORE_METHOD_METADATA[method].feishu).toBe('session-console');
      expect(isCoreMethodAllowed(AccessSurface.FeishuSessionConsole, method)).toBe(true);
    }
    expect(isCoreMethodAllowed(AccessSurface.FeishuSessionConsole, 'system.health')).toBe(false);
  });

  it('does not treat the restricted Relay Worker attachment as a Core client surface', () => {
    expect(coreMethodsForSurface(AccessSurface.RelayWorkerAttach)).toEqual([]);
    expect(isCoreMethodAllowed(AccessSurface.RelayWorkerAttach, 'session.list')).toBe(false);
  });
});
