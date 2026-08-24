import { describe, expect, it, vi } from 'vitest';

import type { SessionAdapterId } from '@shared/types';
import {
  ProjectTrustConflictError,
  ProjectTrustGrantError,
  ProjectTrustService,
  projectTrustDescriptor,
  type ProjectTrustObservation,
  type ProjectTrustProviderPort,
} from './core';

function descriptor(status: 'trusted' | 'untrusted' | 'unknown', version: string) {
  return projectTrustDescriptor({
    adapterId: 'claude-code',
    canGrant: status === 'untrusted',
    identity: '/project',
    nativeVersion: version,
    reasonCode: status === 'unknown' ? 'state-unreadable' : null,
    status,
  });
}

function service(provider: ProjectTrustProviderPort): ProjectTrustService {
  return new ProjectTrustService(Object.fromEntries(
    (['claude-code', 'codex-cli', 'grok-build'] satisfies SessionAdapterId[])
      .map((adapterId) => [adapterId, provider]),
  ) as Record<SessionAdapterId, ProjectTrustProviderPort>);
}

const INPUT = { adapterId: 'claude-code' as const, cwd: '/project' };

describe('ProjectTrustService', () => {
  it('binds opaque revisions to the provider identity and native state', () => {
    const first = projectTrustDescriptor({
      adapterId: 'claude-code', canGrant: true, identity: '/a', nativeVersion: 'v1',
      reasonCode: null, status: 'untrusted',
    });
    const same = projectTrustDescriptor({
      adapterId: 'claude-code', canGrant: true, identity: '/a', nativeVersion: 'v1',
      reasonCode: null, status: 'untrusted',
    });
    const other = projectTrustDescriptor({
      adapterId: 'claude-code', canGrant: true, identity: '/b', nativeVersion: 'v1',
      reasonCode: null, status: 'untrusted',
    });
    expect(first.revision).toBe(same.revision);
    expect(first.revision).not.toBe(other.revision);
    expect(first).not.toHaveProperty('identity');
  });

  it('accepts a stable diagnostic without a grant and rejects stale untrusted evidence', async () => {
    let current: ProjectTrustObservation = { descriptor: descriptor('unknown', 'v1') };
    const trust = service({ observe: vi.fn(async () => current) });

    await expect(trust.apply(INPUT, {
      revision: current.descriptor.revision, grant: false,
    })).resolves.toEqual(current.descriptor);

    const stale = descriptor('untrusted', 'v1');
    current = { descriptor: descriptor('untrusted', 'v2'), grant: vi.fn() };
    await expect(trust.apply(INPUT, {
      revision: stale.revision, grant: false,
    })).rejects.toBeInstanceOf(ProjectTrustConflictError);

    current = { descriptor: descriptor('trusted', 'v3') };
    await expect(trust.apply(INPUT, {
      revision: stale.revision, grant: false,
    })).resolves.toEqual(current.descriptor);
  });

  it('persists only an explicit current grant and verifies the native result', async () => {
    let trusted = false;
    const grant = vi.fn(async () => { trusted = true; });
    const provider: ProjectTrustProviderPort = {
      observe: vi.fn(async () => trusted
        ? { descriptor: descriptor('trusted', 'v2') }
        : { descriptor: descriptor('untrusted', 'v1'), grant }),
    };
    const trust = service(provider);
    const initial = await trust.describe(INPUT);

    await expect(trust.apply(INPUT, {
      revision: initial.revision, grant: true,
    })).resolves.toMatchObject({ status: 'trusted' });
    expect(grant).toHaveBeenCalledOnce();

    await expect(trust.apply(INPUT, {
      revision: initial.revision, grant: true,
    })).resolves.toMatchObject({ status: 'trusted' });
    expect(grant).toHaveBeenCalledOnce();
  });

  it('fails closed when a grant errors or cannot be verified', async () => {
    const failedGrant = vi.fn(async () => { throw new Error('native failure'); });
    const initial = descriptor('untrusted', 'v1');
    await expect(service({
      observe: async () => ({ descriptor: initial, grant: failedGrant }),
    }).apply(INPUT, { revision: initial.revision, grant: true }))
      .rejects.toBeInstanceOf(ProjectTrustGrantError);

    await expect(service({
      observe: async () => ({ descriptor: initial, grant: async () => undefined }),
    }).apply(INPUT, { revision: initial.revision, grant: true }))
      .rejects.toBeInstanceOf(ProjectTrustGrantError);
  });

  it('turns provider exceptions into one path-free diagnostic descriptor', async () => {
    const trust = service({ observe: async () => { throw new Error('/private/provider-home'); } });
    const result = await trust.describe(INPUT);
    expect(result).toMatchObject({
      status: 'unknown', canGrant: false, reasonCode: 'provider-unavailable',
    });
    expect(JSON.stringify(result)).not.toContain('/private/provider-home');
  });
});
