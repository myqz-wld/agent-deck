import { describe, expect, it } from 'vitest';

import {
  BrowserLeaseRegistryCore,
  BrowserLeaseResolutionError,
} from './browser-lease-registry-core';

function leaseGenerator(...leases: string[]): () => string {
  let index = 0;
  return () => leases[index++] ?? `lease-${index}`;
}

const RUNTIME_A = {
  applicationSessionId: 'session-a',
  adapterId: 'codex-cli',
  runtimeGeneration: 1,
  sourceIdentity: 'local-runtime-a',
} as const;

const PROOF_A = {
  adapterId: 'codex-cli',
  runtimeGeneration: 1,
  sourceIdentity: 'local-runtime-a',
} as const;

describe('Browser-only lease registry core', () => {
  it('resolves a lease only for its exact authenticated runtime identity', () => {
    const registry = new BrowserLeaseRegistryCore({
      now: () => 1_000,
      generateLease: leaseGenerator('lease-a'),
    });
    const issued = registry.issue(RUNTIME_A, 5_000);

    expect(registry.resolve(issued.lease, PROOF_A)).toEqual({
      ...RUNTIME_A,
      expiresAt: 6_000,
    });
    expect(() => registry.resolve(issued.lease, {
      ...PROOF_A,
      sourceIdentity: 'local-runtime-b',
    })).toThrow(BrowserLeaseResolutionError);
    expect(() => registry.resolve(issued.lease, {
      ...PROOF_A,
      adapterId: 'claude-code',
    })).toThrow(BrowserLeaseResolutionError);
  });

  it('revokes explicitly and rejects replay without leaking the lease in errors', () => {
    const registry = new BrowserLeaseRegistryCore({
      now: () => 1_000,
      generateLease: leaseGenerator('secret-browser-lease'),
    });
    const issued = registry.issue(RUNTIME_A, 5_000);

    expect(registry.revoke(issued.lease)).toBe(true);
    expect(registry.revoke(issued.lease)).toBe(false);
    let caught: unknown;
    try {
      registry.resolve(issued.lease, PROOF_A);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BrowserLeaseResolutionError);
    expect(caught).toMatchObject({ code: 'browser_context_unavailable' });
    expect(String(caught)).not.toContain(issued.lease);
    expect(JSON.stringify(caught)).not.toContain(issued.lease);
  });

  it('rotates a runtime lease and fences the previous generation', () => {
    const registry = new BrowserLeaseRegistryCore({
      now: () => 1_000,
      generateLease: leaseGenerator('lease-generation-1', 'lease-generation-2'),
    });
    const first = registry.issue(RUNTIME_A, 5_000);
    const second = registry.issue({ ...RUNTIME_A, runtimeGeneration: 2 }, 5_000);

    expect(() => registry.resolve(first.lease, PROOF_A)).toThrow(BrowserLeaseResolutionError);
    expect(registry.revokeRuntime(RUNTIME_A)).toBe(false);
    expect(registry.resolve(second.lease, {
      ...PROOF_A,
      runtimeGeneration: 2,
    })).toMatchObject({ applicationSessionId: 'session-a', runtimeGeneration: 2 });
    expect(() => registry.resolve(second.lease, PROOF_A)).toThrow(BrowserLeaseResolutionError);
  });

  it('expires deterministically and supports session-wide lifecycle revocation', () => {
    let now = 1_000;
    const registry = new BrowserLeaseRegistryCore({
      now: () => now,
      generateLease: leaseGenerator('lease-a', 'lease-b'),
    });
    const first = registry.issue(RUNTIME_A, 500);
    const second = registry.issue({
      applicationSessionId: 'session-b',
      adapterId: 'grok-build',
      runtimeGeneration: 4,
      sourceIdentity: 'remote-runtime-b',
    }, 5_000);

    now = 1_500;
    expect(() => registry.resolve(first.lease, PROOF_A)).toThrow(BrowserLeaseResolutionError);
    expect(registry.pruneExpired()).toBe(0);
    expect(registry.revokeSession('session-b')).toBe(1);
    expect(() => registry.resolve(second.lease, {
      adapterId: 'grok-build', runtimeGeneration: 4, sourceIdentity: 'remote-runtime-b',
    })).toThrow(BrowserLeaseResolutionError);
  });

  it('reports only aggregate diagnostics and never raw capabilities', () => {
    const registry = new BrowserLeaseRegistryCore({
      now: () => 1_000,
      generateLease: leaseGenerator('diagnostic-secret'),
    });
    registry.issue(RUNTIME_A, 5_000);

    expect(registry.diagnostics()).toEqual({ activeLeases: 1, sessions: 1 });
    expect(JSON.stringify(registry.diagnostics())).not.toContain('diagnostic-secret');
  });

  it('renames the stable application owner without rotating or exposing the lease', () => {
    const registry = new BrowserLeaseRegistryCore({
      now: () => 1_000,
      generateLease: leaseGenerator('rename-secret'),
    });
    const issued = registry.issue(RUNTIME_A, 5_000);

    expect(registry.renameSession('session-a', 'session-real')).toBe(1);
    expect(registry.resolve(issued.lease, PROOF_A)).toMatchObject({
      applicationSessionId: 'session-real',
    });
    expect(registry.revokeSession('session-a')).toBe(0);
    expect(registry.revokeSession('session-real')).toBe(1);
  });
});
