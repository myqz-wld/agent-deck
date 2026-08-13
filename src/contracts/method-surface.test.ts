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
    expect(isCoreMethodAllowed(AccessSurface.FeishuSessionConsole, 'session.list')).toBe(false);
    expect(isCoreMethodAllowed(AccessSurface.FeishuSessionConsole, 'session.get')).toBe(false);
    expect(isCoreMethodAllowed(AccessSurface.FeishuSessionConsole, 'session.create')).toBe(false);
    expect(isCoreMethodAllowed(
      AccessSurface.FeishuSessionConsole,
      'session.file-changes.list',
    )).toBe(false);
    expect(isCoreMethodAllowed(
      AccessSurface.FeishuSessionConsole,
      'session.assets.image-chunk.read',
    )).toBe(false);
    expect(isCoreMethodAllowed(AccessSurface.FeishuSessionConsole, 'session.tasks.list')).toBe(false);
    expect(isCoreMethodAllowed(AccessSurface.FeishuSessionConsole, 'session.events.list')).toBe(false);
    expect(isCoreMethodAllowed(AccessSurface.FeishuSessionConsole, 'teams.list')).toBe(false);
    expect(isCoreMethodAllowed(AccessSurface.FeishuSessionConsole, 'usage.tokens.get')).toBe(false);
    expect(isCoreMethodAllowed(
      AccessSurface.FeishuSessionConsole,
      'node.configuration.get',
    )).toBe(false);
    expect(isCoreMethodAllowed(
      AccessSurface.FeishuSessionConsole,
      'node.hook.projection.install',
    )).toBe(false);
    expect(isCoreMethodAllowed(AccessSurface.FeishuSessionConsole, 'node.assets.list')).toBe(false);
    expect(isCoreMethodAllowed(AccessSurface.FeishuSessionConsole, 'issues.list')).toBe(false);
    expect(isCoreMethodAllowed(
      AccessSurface.FeishuSessionConsole,
      'session.context.get',
    )).toBe(false);
    expect(isCoreMethodAllowed(
      AccessSurface.FeishuSessionConsole,
      'session.input.capabilities',
    )).toBe(false);
    expect(isCoreMethodAllowed(
      AccessSurface.FeishuSessionConsole,
      'session.handoff.commit',
    )).toBe(false);
    expect(isCoreMethodAllowed(
      AccessSurface.FeishuSessionConsole,
      'workspace.directory.create',
    )).toBe(false);
    expect(isCoreMethodAllowed(AccessSurface.FeishuSessionConsole, 'session.archive')).toBe(false);
    expect(isCoreMethodAllowed(AccessSurface.FeishuSessionConsole, 'session.delete')).toBe(false);
    expect(isCoreMethodAllowed(AccessSurface.FeishuSessionConsole, 'session.console.list')).toBe(true);
    expect(isCoreMethodAllowed(AccessSurface.FeishuSessionConsole, 'session.console.get')).toBe(true);
    expect(isCoreMethodAllowed(AccessSurface.FeishuSessionConsole, 'project.resolve')).toBe(true);
    expect(isCoreMethodAllowed(AccessSurface.FeishuSessionConsole, 'session.console.create')).toBe(true);
  });

  it('does not treat the restricted Relay Worker attachment as a Core client surface', () => {
    expect(coreMethodsForSurface(AccessSurface.RelayWorkerAttach)).toEqual([]);
    expect(isCoreMethodAllowed(AccessSurface.RelayWorkerAttach, 'session.list')).toBe(false);
  });
});
