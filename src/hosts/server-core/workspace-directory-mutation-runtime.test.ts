import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AuthenticatedClientAccessContext,
  JsonObject,
  JsonValue,
} from '@contracts/index';
import type { DaemonCoreRuntime, DaemonRequestInput } from '@hosts/daemon';
import type {
  ServerCoreMutationClaim,
  ServerCoreMutationIdentity,
} from './runtime-metadata-store';

import { ServerCoreWorkspaceDirectoryMutationRuntime } from './workspace-directory-mutation-runtime';

const desktop: AuthenticatedClientAccessContext = {
  kind: 'authenticated-client', topology: 'server-core', instanceId: 'instance-a',
  clientId: 'desktop-a', transport: 'ssh', accessCredentialId: 'credential-a',
  authority: 'owner-equivalent', surface: 'desktop-full',
};
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function request(
  params: JsonObject,
  idempotencyKey: string,
  access = desktop,
): DaemonRequestInput {
  return {
    access, requestId: idempotencyKey, method: 'workspace.directory.create', params,
    idempotencyKey, expectedRevision: null, deadlineAt: null,
    signal: new AbortController().signal,
  };
}

function harness() {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'agent-deck-workspace-runtime-'));
  roots.push(workspaceRoot);
  mkdirSync(join(workspaceRoot, 'repo'));
  let revision = 7;
  const claims = new Map<string, {
    identity: ServerCoreMutationIdentity;
    result?: JsonValue;
    revision?: number;
  }>();
  const metadata = {
    claimMutation: vi.fn((identity: ServerCoreMutationIdentity): ServerCoreMutationClaim => {
      const prior = claims.get(identity.idempotencyKey);
      if (!prior) {
        claims.set(identity.idempotencyKey, { identity });
        return { state: 'claimed' };
      }
      if (
        prior.identity.method !== identity.method ||
        prior.identity.requestFingerprint !== identity.requestFingerprint
      ) return { state: 'conflict' };
      if (prior.result === undefined || prior.revision === undefined) return { state: 'uncertain' };
      return { state: 'completed', result: prior.result, revision: prior.revision };
    }),
    appendChange: vi.fn(() => ++revision),
    completeMutation: vi.fn((
      identity: ServerCoreMutationIdentity,
      result: JsonValue,
      resultRevision: number,
    ) => {
      const claim = claims.get(identity.idempotencyKey);
      if (!claim) throw new Error('missing claim');
      claim.result = result;
      claim.revision = resultRevision;
    }),
    releaseMutationClaim: vi.fn((identity: ServerCoreMutationIdentity) => {
      claims.delete(identity.idempotencyKey);
    }),
  };
  const base = {
    supportedMethods: ['system.health'], start: vi.fn(), stop: vi.fn(),
    currentRevision: () => revision, execute: vi.fn(),
  } as unknown as DaemonCoreRuntime;
  return {
    metadata,
    runtime: new ServerCoreWorkspaceDirectoryMutationRuntime(base, { workspaceRoot, metadata }),
  };
}

describe('ServerCoreWorkspaceDirectoryMutationRuntime', () => {
  it('creates one bounded directory and replays the completed intent', async () => {
    const state = harness();
    const input = request({ parentDirectory: 'repo', name: 'new-folder' }, 'intent-create');
    const first = await state.runtime.execute(input);
    await expect(state.runtime.execute(input)).resolves.toEqual(first);
    expect(first).toEqual({
      result: { directory: 'repo/new-folder', revision: 8 },
      revision: 8,
    });
    expect(state.metadata.appendChange).toHaveBeenCalledOnce();
  });

  it('returns a conflict for an existing directory and releases the intent', async () => {
    const state = harness();
    await state.runtime.execute(request({ parentDirectory: 'repo', name: 'existing' }, 'first'));
    await expect(state.runtime.execute(request(
      { parentDirectory: 'repo', name: 'existing' },
      'second',
    ))).rejects.toMatchObject({ code: 'conflict' });
    expect(state.metadata.releaseMutationClaim).toHaveBeenCalledOnce();
  });

  it('denies the Feishu surface before claiming an intent', async () => {
    const state = harness();
    const feishu = {
      ...desktop, clientId: 'feishu-a', transport: 'feishu' as const,
      surface: 'feishu-session-console' as const,
    };
    await expect(state.runtime.execute(request(
      { parentDirectory: 'repo', name: 'denied' },
      'intent-feishu',
      feishu,
    ))).rejects.toMatchObject({ code: 'access_denied' });
    expect(state.metadata.claimMutation).not.toHaveBeenCalled();
  });
});
