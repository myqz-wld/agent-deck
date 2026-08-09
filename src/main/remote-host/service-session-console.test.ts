import { describe, expect, it, vi } from 'vitest';

import { sessionConsoleCapabilitiesFixture } from '@contracts/session-console-capabilities.fixture';
import type { RemoteHostScopedClient } from './service-scope';
import {
  requestRemoteSessionCapabilities,
  requestRemoteSession,
  requestRemoteWorkspaceDirectories,
} from './service-session-console';

function scope(request: ReturnType<typeof vi.fn>): RemoteHostScopedClient {
  return {
    client: { request } as unknown as RemoteHostScopedClient['client'],
    profileEpoch: 1,
    profileId: 'remote-a',
    sourceEpoch: 1,
  };
}

describe('Remote session-console request helpers', () => {
  it('rejects a targeted session response with another identity', async () => {
    const request = vi.fn(async () => ({
      session: {
        id: 'session-b', adapterId: 'codex-cli', title: 'Other', status: 'idle',
        createdAt: 1, updatedAt: 2,
      },
      revision: 2,
    }));
    await expect(requestRemoteSession(scope(request), {
      profileId: 'remote-a', sessionId: 'session-a',
    })).rejects.toThrow();
  });

  it('requests and binds the authoritative creation capability descriptor', async () => {
    const descriptor = sessionConsoleCapabilitiesFixture('codex-cli', 'repo');
    const request = vi.fn(async () => descriptor);

    await expect(requestRemoteSessionCapabilities(scope(request), {
      profileId: 'remote-a',
      adapterId: 'codex-cli',
      provider: '',
      workingDirectory: 'repo',
    })).resolves.toEqual(descriptor);
    expect(request).toHaveBeenCalledWith('session.console.capabilities', {
      adapterId: 'codex-cli', provider: '', workingDirectory: 'repo',
    }, { deadlineMs: 45_000 });
  });

  it('requests only Workspace-relative directory projections', async () => {
    const result = {
      directory: '.',
      directories: [{ directory: 'repo', name: 'repo' }],
      truncated: false,
      revision: 3,
    };
    const request = vi.fn(async () => result);

    await expect(requestRemoteWorkspaceDirectories(scope(request), {
      profileId: 'remote-a', directory: '.',
    })).resolves.toEqual(result);
    expect(request).toHaveBeenCalledWith(
      'workspace.directory.list',
      { directory: '.' },
      { deadlineMs: 45_000 },
    );
  });
});
