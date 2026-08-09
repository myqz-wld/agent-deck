import { describe, expect, it, vi } from 'vitest';
import { createClaudeSessionManagerPort } from './session-manager-core';

describe('Claude session manager Core', () => {
  it('preserves claim ownership, pending release, deletion, and promise identity', async () => {
    const release = vi.fn();
    const deletion = Promise.resolve();
    const unarchive = Promise.resolve();
    const host = {
      claimAsSdk: vi.fn(),
      releaseSdkClaim: vi.fn(),
      markRecentlyDeleted: vi.fn(),
      expectSdkSession: vi.fn(() => release),
      delete: vi.fn(() => deletion),
      getCloseEpoch: vi.fn(() => 7),
      markClosed: vi.fn(),
      unarchive: vi.fn(() => unarchive),
      renameSdkSession: vi.fn(),
      updateCliSessionId: vi.fn(),
    };
    const port = createClaudeSessionManagerPort(host);

    port.claimAsSdk('session-a');
    port.releaseSdkClaim('session-a');
    port.markRecentlyDeleted('session-a', 'native-a');
    expect(port.expectSdkSession('/repo', 60_000)).toBe(release);
    const pendingDelete = port.delete('session-a');
    expect(port.getCloseEpoch('session-a')).toBe(7);
    port.markClosed('session-a');
    const pendingUnarchive = port.unarchive('session-a');
    port.renameSdkSession('temporary-a', 'session-a');
    port.updateCliSessionId('session-a', 'native-a');

    expect(host.claimAsSdk).toHaveBeenCalledWith('session-a');
    expect(host.releaseSdkClaim).toHaveBeenCalledWith('session-a');
    expect(host.markRecentlyDeleted).toHaveBeenCalledWith('session-a', 'native-a');
    expect(host.expectSdkSession).toHaveBeenCalledWith('/repo', 60_000);
    expect(host.delete).toHaveBeenCalledWith('session-a');
    expect(host.getCloseEpoch).toHaveBeenCalledWith('session-a');
    expect(host.markClosed).toHaveBeenCalledWith('session-a');
    expect(host.unarchive).toHaveBeenCalledWith('session-a');
    expect(host.renameSdkSession).toHaveBeenCalledWith('temporary-a', 'session-a');
    expect(host.updateCliSessionId).toHaveBeenCalledWith('session-a', 'native-a');
    expect(pendingDelete).toBe(deletion);
    expect(pendingUnarchive).toBe(unarchive);
    await Promise.all([pendingDelete, pendingUnarchive]);
  });
});
