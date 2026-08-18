import { randomBytes } from 'node:crypto';

import type { RuntimeAdapterId } from '@shared/types';

export const BROWSER_LEASE_DEFAULT_TTL_MS = 15 * 60_000;
export const BROWSER_LEASE_MAX_TTL_MS = 24 * 60 * 60_000;

export interface BrowserRuntimeIdentity {
  readonly applicationSessionId: string;
  readonly adapterId: RuntimeAdapterId;
  readonly runtimeGeneration: number;
  readonly sourceIdentity: string;
}

export interface BrowserLeaseBinding extends BrowserRuntimeIdentity {
  readonly expiresAt: number;
}

export interface BrowserLeaseProof {
  readonly adapterId: RuntimeAdapterId;
  readonly runtimeGeneration: number;
  readonly sourceIdentity: string;
}

export interface IssuedBrowserLease {
  readonly lease: string;
  readonly expiresAt: number;
}

export interface BrowserLeaseRegistryOptions {
  readonly now?: () => number;
  readonly generateLease?: () => string;
}

export type BrowserLeaseFailureReason =
  | 'missing'
  | 'expired'
  | 'identity-mismatch';

/** Public lease failures intentionally collapse to one non-oracular error code. */
export class BrowserLeaseResolutionError extends Error {
  readonly code = 'browser_context_unavailable' as const;

  constructor(readonly reason: BrowserLeaseFailureReason) {
    super('Browser context is unavailable for this runtime.');
    this.name = 'BrowserLeaseResolutionError';
  }

  toJSON(): { code: 'browser_context_unavailable'; message: string } {
    return { code: this.code, message: this.message };
  }
}

interface LeaseRecord {
  readonly binding: BrowserLeaseBinding;
  readonly runtimeKey: string;
}

function framed(values: readonly (string | number)[]): string {
  return values.map((value) => {
    const text = String(value);
    return `${Buffer.byteLength(text)}:${text}`;
  }).join('|');
}

function runtimeKey(identity: BrowserRuntimeIdentity): string {
  return framed([
    identity.applicationSessionId,
    identity.adapterId,
    identity.sourceIdentity,
  ]);
}

function assertIdentity(identity: BrowserRuntimeIdentity): void {
  for (const [field, value] of [
    ['applicationSessionId', identity.applicationSessionId],
    ['sourceIdentity', identity.sourceIdentity],
  ] as const) {
    if (value.length === 0 || Buffer.byteLength(value) > 512) {
      throw new Error(`Invalid Browser runtime ${field}.`);
    }
  }
  if (!Number.isSafeInteger(identity.runtimeGeneration) || identity.runtimeGeneration < 0) {
    throw new Error('Invalid Browser runtime generation.');
  }
}

function defaultGenerateLease(): string {
  return randomBytes(32).toString('base64url');
}

/** Memory-only bidirectional registry for browser-scoped runtime authority. */
export class BrowserLeaseRegistryCore {
  private readonly records = new Map<string, LeaseRecord>();
  private readonly leaseByRuntime = new Map<string, string>();
  private readonly leasesBySession = new Map<string, Set<string>>();
  private readonly now: () => number;
  private readonly generateLease: () => string;

  constructor(options: BrowserLeaseRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.generateLease = options.generateLease ?? defaultGenerateLease;
  }

  issue(
    identity: BrowserRuntimeIdentity,
    ttlMs = BROWSER_LEASE_DEFAULT_TTL_MS,
  ): IssuedBrowserLease {
    assertIdentity(identity);
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > BROWSER_LEASE_MAX_TTL_MS) {
      throw new Error('Invalid Browser lease lifetime.');
    }
    const key = runtimeKey(identity);
    const current = this.leaseByRuntime.get(key);
    if (current != null) this.remove(current);

    const lease = this.allocateLease();
    const expiresAt = this.now() + ttlMs;
    const binding = Object.freeze({ ...identity, expiresAt });
    this.records.set(lease, { binding, runtimeKey: key });
    this.leaseByRuntime.set(key, lease);
    const sessionLeases = this.leasesBySession.get(identity.applicationSessionId) ?? new Set();
    sessionLeases.add(lease);
    this.leasesBySession.set(identity.applicationSessionId, sessionLeases);
    return { lease, expiresAt };
  }

  resolve(lease: string, proof: BrowserLeaseProof): BrowserLeaseBinding {
    const record = this.records.get(lease);
    if (record == null) throw new BrowserLeaseResolutionError('missing');
    if (record.binding.expiresAt <= this.now()) {
      this.remove(lease);
      throw new BrowserLeaseResolutionError('expired');
    }
    if (
      record.binding.adapterId !== proof.adapterId ||
      record.binding.runtimeGeneration !== proof.runtimeGeneration ||
      record.binding.sourceIdentity !== proof.sourceIdentity
    ) {
      throw new BrowserLeaseResolutionError('identity-mismatch');
    }
    return record.binding;
  }

  revoke(lease: string): boolean {
    return this.remove(lease);
  }

  revokeSession(applicationSessionId: string): number {
    const leases = [...(this.leasesBySession.get(applicationSessionId) ?? [])];
    for (const lease of leases) this.remove(lease);
    return leases.length;
  }

  renameSession(fromApplicationSessionId: string, toApplicationSessionId: string): number {
    if (fromApplicationSessionId === toApplicationSessionId) return 0;
    if (toApplicationSessionId.length === 0 || Buffer.byteLength(toApplicationSessionId) > 512) {
      throw new Error('Invalid Browser runtime applicationSessionId.');
    }
    const leases = [...(this.leasesBySession.get(fromApplicationSessionId) ?? [])];
    let renamed = 0;
    for (const lease of leases) {
      const record = this.records.get(lease);
      if (record == null) continue;
      const replacementIdentity = {
        ...record.binding,
        applicationSessionId: toApplicationSessionId,
      };
      const replacementKey = runtimeKey(replacementIdentity);
      const conflicting = this.leaseByRuntime.get(replacementKey);
      if (conflicting != null && conflicting !== lease) this.remove(conflicting);
      if (this.leaseByRuntime.get(record.runtimeKey) === lease) {
        this.leaseByRuntime.delete(record.runtimeKey);
      }
      const replacement: LeaseRecord = {
        binding: Object.freeze(replacementIdentity),
        runtimeKey: replacementKey,
      };
      this.records.set(lease, replacement);
      this.leaseByRuntime.set(replacementKey, lease);
      this.leasesBySession.get(fromApplicationSessionId)?.delete(lease);
      const target = this.leasesBySession.get(toApplicationSessionId) ?? new Set<string>();
      target.add(lease);
      this.leasesBySession.set(toApplicationSessionId, target);
      renamed += 1;
    }
    if (this.leasesBySession.get(fromApplicationSessionId)?.size === 0) {
      this.leasesBySession.delete(fromApplicationSessionId);
    }
    return renamed;
  }

  revokeRuntime(identity: BrowserRuntimeIdentity): boolean {
    const lease = this.leaseByRuntime.get(runtimeKey(identity));
    if (lease == null) return false;
    const record = this.records.get(lease);
    if (record?.binding.runtimeGeneration !== identity.runtimeGeneration) return false;
    return this.remove(lease);
  }

  revokeAll(): number {
    const count = this.records.size;
    this.records.clear();
    this.leaseByRuntime.clear();
    this.leasesBySession.clear();
    return count;
  }

  pruneExpired(): number {
    const now = this.now();
    let removed = 0;
    for (const [lease, record] of this.records) {
      if (record.binding.expiresAt > now) continue;
      if (this.remove(lease)) removed += 1;
    }
    return removed;
  }

  diagnostics(): { activeLeases: number; sessions: number } {
    this.pruneExpired();
    return {
      activeLeases: this.records.size,
      sessions: this.leasesBySession.size,
    };
  }

  private allocateLease(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const lease = this.generateLease();
      if (lease.length === 0 || Buffer.byteLength(lease) > 1_024) continue;
      if (!this.records.has(lease)) return lease;
    }
    throw new Error('Unable to allocate a unique Browser lease.');
  }

  private remove(lease: string): boolean {
    const record = this.records.get(lease);
    if (record == null) return false;
    this.records.delete(lease);
    if (this.leaseByRuntime.get(record.runtimeKey) === lease) {
      this.leaseByRuntime.delete(record.runtimeKey);
    }
    const sessionLeases = this.leasesBySession.get(record.binding.applicationSessionId);
    sessionLeases?.delete(lease);
    if (sessionLeases?.size === 0) {
      this.leasesBySession.delete(record.binding.applicationSessionId);
    }
    return true;
  }
}
