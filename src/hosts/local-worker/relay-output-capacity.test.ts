import { describe, expect, it, vi } from 'vitest';
import {
  issueRemoteOwnerGrantClaim, parseSessionEventListResult, type JsonValue,
} from '@contracts/index';
import type { SessionRecord, StoredAgentEvent } from '@shared/types';
import type { DaemonCoreRuntime } from '@hosts/daemon';
import { projectSessionEvents } from '@hosts/server-core/session-event-projection';
import { CURRENT_PROTOCOL_VERSION, encodeJsonFrame, LengthPrefixedJsonDecoder } from '@protocol/index';
import type { RelayRouteFrame } from '@protocol/relay';
import { waitFor } from '../daemon/connection-test-helpers';
import { createLocalWorkerDaemonFrameChannels } from './daemon-frame-channels';
import { LocalWorkerFrameBridge, DEFAULT_LOCAL_WORKER_BRIDGE_LIMITS } from './frame-bridge';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(result: JsonValue, limits = DEFAULT_LOCAL_WORKER_BRIDGE_LIMITS) {
  const emitted: RelayRouteFrame[] = [];
  const sequences = new Map<string, number>();
  const runtime: DaemonCoreRuntime = {
    supportedMethods: ['session.events.list'],
    start: async () => undefined,
    stop: async () => undefined,
    currentRevision: () => 100,
    execute: async () => ({ result, revision: 100 }),
  };
  const bridge = new LocalWorkerFrameBridge('instance-1', 1,
    createLocalWorkerDaemonFrameChannels({
      instanceId: 'instance-1', appVersion: 'test', authoritativeCoreId: 'core-1',
      runtime, getWorkerGeneration: () => 1,
    }),
    (frame) => emitted.push(frame), limits);
  const accept = (streamId: string, kind: RelayRouteFrame['kind'], payload: Uint8Array = new Uint8Array(), creditBytes: number | null = null) => {
    const sequence = kind === 'open' ? 0 : sequences.get(streamId)!;
    sequences.set(streamId, sequence + 1);
    bridge.accept({
      instanceId: 'instance-1', generation: 1, streamId, direction: 'client-to-worker',
      sequence, kind, payload, creditBytes, resetCode: kind === 'reset' ? 'cancelled' : null,
      connectionScope: kind === 'open' ? 'scope-1' : null,
      accessSurface: kind === 'open' ? 'desktop' : null,
      accessGrant: kind === 'open' ? issueRemoteOwnerGrantClaim('desktop') : null,
    });
  };
  const data = (streamId: string) => emitted.filter((frame) => frame.streamId === streamId && frame.kind === 'data');
  const bytes = (streamId: string) => Buffer.concat(data(streamId).map((frame) => Buffer.from(frame.payload)));
  const hello = async (streamId: string) => {
    emitted.splice(0, emitted.length, ...emitted.filter((frame) => frame.streamId !== streamId));
    accept(streamId, 'open');
    accept(streamId, 'data', encodeJsonFrame({
      type: 'hello', requestId: 'hello', hello: {
        protocolVersion: CURRENT_PROTOCOL_VERSION, appVersion: 'test',
        clientId: streamId, requestedTopology: 'relay',
      },
    }));
    const decoder = new LengthPrefixedJsonDecoder();
    const messages: JsonValue[] = [];
    let cursor = 0;
    // A small negotiated route ceiling may also fragment the hello.
    await waitFor(() => {
      for (const frame of data(streamId).slice(cursor)) {
        cursor += 1;
        messages.push(...decoder.push(frame.payload));
        accept(streamId, 'credit', new Uint8Array(), frame.payload.byteLength);
      }
      return messages.length > 0;
    }, 'complete Relay hello');
    expect(messages[0]).toMatchObject({ type: 'hello-result', hello: { limits: { maxFrameBytes: 4 * 1024 * 1024 } } });
    emitted.splice(0, emitted.length, ...emitted.filter((frame) => frame.streamId !== streamId));
  };
  const request = (streamId: string) => accept(streamId, 'data', encodeJsonFrame({
    type: 'request', requestId: 'events', method: 'session.events.list',
    params: { sessionId: 'session-1', limit: 100 }, idempotencyKey: null,
    expectedRevision: null, deadlineAt: null,
  }));
  const drain = async (streamId: string, expected: Uint8Array, credited = 0) => {
    for (let round = 0; bytes(streamId).byteLength < expected.byteLength && round < 200; round += 1) {
      await tick();
      const frames = data(streamId);
      for (const frame of frames.slice(credited)) {
        credited += 1;
        accept(streamId, 'credit', new Uint8Array(), frame.payload.byteLength);
      }
      expect(bridge.queuedOutputBytes()).toBeLessThanOrEqual(limits.maxOutputQueueBytesTotal);
      expect(bridge.queuedOutputFrames()).toBeLessThanOrEqual(limits.maxOutputQueueFramesTotal);
    }
    expect(bytes(streamId).equals(Buffer.from(expected))).toBe(true);
    expect(emitted.filter((frame) => frame.streamId === streamId && frame.kind === 'reset')).toEqual([]);
    const sequence = emitted.filter((frame) => frame.streamId === streamId).map((frame) => frame.sequence);
    expect(sequence).toEqual(sequence.map((_, index) => sequence[0] + index));
    expect(new LengthPrefixedJsonDecoder().push(bytes(streamId))).toEqual([
      { type: 'result', requestId: 'events', result, revision: 100 },
    ]);
  };
  return { bridge, emitted, accept, bytes, hello, request, drain };
}

function response(result: JsonValue): Uint8Array {
  return encodeJsonFrame({ type: 'result', requestId: 'events', result, revision: 100 });
}

function projectedEvents(textKiB = 10): JsonValue {
  const events = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1, sessionId: 'session-1', agentId: 'codex-cli', kind: 'message',
    payload: { role: 'assistant', text: 'a'.repeat(textKiB * 1024) }, ts: 1_710_000_000_000 + index,
  })) as StoredAgentEvent[];
  const projection = projectSessionEvents(events, { id: 'session-1', agentId: 'codex-cli' } as SessionRecord,
    100, { workspaceRoot: '/workspace', privateRoots: [] });
  return parseSessionEventListResult({ ...projection, revision: 100 }, 'session-1', 100) as unknown as JsonValue;
}

describe('daemon to Relay output capacity', () => {
  it.each([10, 30])('delivers 100 real %i KiB events after asynchronous credit exhaustion', async (textKiB) => {
    const result = projectedEvents(textKiB);
    const expected = response(result);
    expect(expected.byteLength).toBeGreaterThan(768 * 1024);
    expect(expected.byteLength).toBeLessThan(3 * 1024 * 1024);
    const f = fixture(result);
    try {
      await f.hello('events');
      f.request('events');
      await tick();
      expect(f.bridge.queuedOutputBytes()).toBe(DEFAULT_LOCAL_WORKER_BRIDGE_LIMITS.maxOutputQueueBytesPerStream);
      expect(f.bytes('events').byteLength).toBeLessThan(expected.byteLength);
      expect(f.bridge.streamCount()).toBe(1);
      await f.drain('events', expected);
    } finally { f.bridge.dispose(); }
  });

  it.each([4 * 1024 * 1024, 32 * 1024])('delivers the advertised 4 MiB Core body through a %i-byte route ceiling', async (maxFrameBytes) => {
    const maximum = 4 * 1024 * 1024;
    const result = 'x'.repeat(maximum + 4 - response('').byteLength);
    const expected = response(result);
    expect(expected.byteLength).toBe(maximum + 4);
    const f = fixture(result, { ...DEFAULT_LOCAL_WORKER_BRIDGE_LIMITS, maxFrameBytes });
    try {
      await f.hello('maximum');
      f.request('maximum');
      await tick();
      expect(f.bridge.streamCount()).toBe(1);
      await f.drain('maximum', expected);
    } finally { f.bridge.dispose(); }
  });

  it('counts partial frame admission as progress while retaining a real stall deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const result = projectedEvents();
    const f = fixture(result);
    try {
      await f.hello('gradual');
      f.request('gradual');
      await tick();
      await vi.advanceTimersByTimeAsync(8_000);
      f.accept('gradual', 'credit', new Uint8Array(), 64 * 1024);
      await tick();
      await vi.advanceTimersByTimeAsync(8_000);
      expect(f.bridge.streamCount()).toBe(1);
      await f.drain('gradual', response(result), 1);

      await f.hello('stalled');
      f.request('stalled');
      await tick();
      await vi.advanceTimersByTimeAsync(10_000);
      await tick();
      expect(f.bridge.streamCount()).toBe(1);
      expect(f.emitted.some((frame) => frame.streamId === 'stalled' && frame.kind === 'reset')).toBe(true);
    } finally {
      f.bridge.dispose();
      vi.useRealTimers();
    }
  });

  it('cancels a blocked writer, fences reused stream ids and lets another stream progress', async () => {
    const result = projectedEvents();
    const expected = response(result);
    const f = fixture(result);
    try {
      await f.hello('slow');
      f.request('slow');
      await tick();
      await f.hello('healthy');
      f.request('healthy');
      await f.drain('healthy', expected);
      expect(f.bridge.streamCount()).toBe(2);
      f.accept('slow', 'reset');
      const emittedAtReset = f.emitted.length;
      await tick();
      expect(f.emitted).toHaveLength(emittedAtReset);
      await f.hello('slow');
      f.request('slow');
      await f.drain('slow', expected);
      expect(f.bridge.streamCount()).toBe(2);
    } finally {
      f.bridge.dispose();
      await tick();
      expect(f.bridge.queuedOutputBytes()).toBe(0);
      expect(f.bridge.queuedOutputFrames()).toBe(0);
    }
  });
});
