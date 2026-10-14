import { describe, expect, it, vi } from 'vitest';
import { RelayMetadataStore } from './metadata';
import { DiagnosticRelayStreamRouter } from './diagnostic-router';
import { createRuntimeDiagnostics } from '@hosts/linux-runtime/runtime-diagnostics';
import type { RelayRouteFrame } from '@protocol/relay';

function metadata() {
  const store = new RelayMetadataStore();
  store.put('instances', { id: 'instance-a', instanceId: 'instance-a', topology: 'relay', createdAt: 0 });
  store.put('credentials', {
    id: 'private-credential', instanceId: 'instance-a', credentialId: 'private-credential',
    kind: 'relay-worker', publicKey: 'ssh-ed25519 AAAATEST', fingerprint: 'SHA256:test',
    status: 'active', createdAt: 0, revokedAt: null,
  });
  return store;
}
const attach = {
  type: 'attach' as const, instanceId: 'instance-a', workerId: 'private-worker',
  credentialId: 'private-credential', mode: 'register' as const,
  generation: null, expectedGeneration: null,
};

describe('Relay lifecycle diagnostic evidence', () => {
  it('records expiration timing and recovery while keeping healthy ticks and private identities quiet', () => {
    const lines: string[] = [];
    const router = new DiagnosticRelayStreamRouter('instance-a', metadata(), createRuntimeDiagnostics({
      now: () => 0, write: (line) => { lines.push(line); },
    }));
    expect(router.attachWorker(attach, 'private-connection', 0).accepted).toBe(true);
    router.tick(1000);
    router.tick(2000);
    expect(lines).toHaveLength(1);
    router.tick(35_000);
    expect(router.status().online).toBe(false);
    expect(JSON.parse(lines[1]!)).toMatchObject({
      event: 'relay-worker-expired', lastHeartbeatAgeMs: 35_000, heartbeatTimeoutMs: 30_000,
      timerLagMs: 32_000, queuedBytes: 0, reason: 'heartbeat_timeout', generation: 1,
    });
    expect(router.attachWorker({ ...attach, mode: 'reconnect', generation: 1 }, 'next-connection', 36_000)
      .accepted).toBe(true);
    expect(JSON.parse(lines[2]!)).toMatchObject({ event: 'relay-worker-attached', elapsedMs: 1000 });
    expect(lines.join('')).not.toMatch(/private-worker|private-credential|private-connection/);
  });

  it('keeps lease transitions and malformed-frame failures independent of the diagnostic sink', () => {
    const fail = vi.fn(() => { throw new Error('broken sink'); });
    const router = new DiagnosticRelayStreamRouter('instance-a', metadata(), { info: fail, warn: fail });
    expect(() => router.attachWorker(attach, 'connection-a', 0)).not.toThrow();
    expect(router.status().online).toBe(true);
    expect(() => router.routeFromClient('unknown', null as never)).toThrow();
    expect(() => router.detachWorker('connection-a', 100)).not.toThrow();
    expect(router.status().online).toBe(false);
  });

  it('records a fenced connection category without reading its forwarded payload', () => {
    const lines: string[] = [];
    const router = new DiagnosticRelayStreamRouter('instance-a', metadata(), createRuntimeDiagnostics({
      now: () => 0, write: (line) => { lines.push(line); },
    }));
    router.attachWorker(attach, 'current-connection', 0);
    const frame: RelayRouteFrame = {
      instanceId: 'instance-a', generation: 1, streamId: 'private-stream', direction: 'worker-to-client',
      sequence: 0, kind: 'data', payload: Buffer.from('PRIVATE PAYLOAD'), creditBytes: null,
      resetCode: null, connectionScope: null, accessSurface: null, accessGrant: null,
    };
    expect(() => router.routeFromWorker('retired-connection', frame, 1)).toThrow();
    expect(JSON.parse(lines[1]!)).toMatchObject({
      event: 'relay-stream-failed', reason: 'worker_fenced', direction: 'worker-to-client',
      streamRef: expect.stringMatching(/^ref-[a-f0-9]{16}$/),
    });
    expect(lines.join('')).not.toMatch(/PRIVATE|private-stream|retired-connection/);
  });
});
