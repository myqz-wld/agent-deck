import { describe, expect, it, vi } from 'vitest';

import type { ElectronHostEvent, ElectronHostRegistry } from '@hosts/electron';
import {
  parseRemoteSessionRename,
  RemoteHostSessionRenameTracker,
} from './remote-session-rename';

function event(payload: ElectronHostEvent['payload']): ElectronHostEvent {
  return {
    profileId: 'remote-a',
    instanceId: 'server-a',
    revision: 7,
    kind: 'session.renamed',
    entityId: 'canonical-a',
    payload,
  };
}

describe('Remote session rename bridge', () => {
  it('updates persisted navigation and qualifies the renderer alias', () => {
    const updateNavigation = vi.fn();
    const registry = {
      state: vi.fn(() => ({
        authoritativeCoreId: 'core-a',
        workerGeneration: 3,
      })),
      navigation: vi.fn(() => ({ selectedSessionId: 'temporary-a' })),
      updateNavigation,
    } as unknown as ElectronHostRegistry;

    const tracker = new RemoteHostSessionRenameTracker();
    expect(tracker.handle(registry, event({
      fromId: 'temporary-a', toId: 'canonical-a',
    }))).toEqual({
      fromId: 'temporary-a',
      toId: 'canonical-a',
      authoritativeCoreId: 'core-a',
      workerGeneration: 3,
    });
    expect(updateNavigation).toHaveBeenCalledWith('remote-a', {
      selectedSessionId: 'canonical-a',
    });
  });

  it('normalizes a create response when its rename event arrived first', () => {
    const updateNavigation = vi.fn();
    const registry = {
      state: vi.fn(() => ({ authoritativeCoreId: 'core-a', workerGeneration: 3 })),
      navigation: vi.fn(() => ({ selectedSessionId: null })),
      updateNavigation,
    } as unknown as ElectronHostRegistry;
    const tracker = new RemoteHostSessionRenameTracker();
    tracker.handle(registry, event({ fromId: 'temporary-a', toId: 'canonical-a' }));

    expect(tracker.selectCreated(registry, 'remote-a', {
      sessionId: 'temporary-a', revision: 8,
    })).toEqual({ sessionId: 'canonical-a', revision: 8 });
    expect(updateNavigation).toHaveBeenLastCalledWith('remote-a', {
      selectedSessionId: 'canonical-a',
    });
  });

  it('rejects malformed or unbounded rename payloads', () => {
    expect(parseRemoteSessionRename({ fromId: '', toId: 'canonical-a' })).toBeNull();
    expect(parseRemoteSessionRename({
      fromId: 'temporary-a', toId: 'x'.repeat(257),
    })).toBeNull();
  });
});
