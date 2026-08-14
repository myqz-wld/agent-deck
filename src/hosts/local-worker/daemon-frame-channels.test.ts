import { describe, expect, it } from 'vitest';

import {
  issueRemoteOwnerGrantClaim,
  type JsonObject,
  type JsonValue,
} from '@contracts/index';
import type { DaemonCoreRuntime } from '@hosts/daemon';
import {
  CURRENT_PROTOCOL_VERSION,
  encodeJsonFrame,
  LengthPrefixedJsonDecoder,
} from '@protocol/index';

import { waitFor } from '../daemon/connection-test-helpers';
import { createLocalWorkerDaemonFrameChannels } from './daemon-frame-channels';

function runtime(): DaemonCoreRuntime {
  return {
    supportedMethods: ['session.console.list'],
    start: async () => undefined,
    stop: async () => undefined,
    currentRevision: () => 7,
    execute: async () => ({ result: { ok: true }, revision: 7 }),
  };
}

function messages(writes: readonly Buffer[]): JsonValue[] {
  return new LengthPrefixedJsonDecoder().push(Buffer.concat(writes));
}

function find(
  writes: readonly Buffer[],
  type: string,
  requestId: string,
): JsonObject | undefined {
  return messages(writes).find((value): value is JsonObject =>
    typeof value === 'object' && value !== null && !Array.isArray(value) &&
    value.type === type && value.requestId === requestId,
  );
}

describe('Local Worker daemon frame channels', () => {
  it('serves a Relay HostHello and Core request over one routed byte stream', async () => {
    const writes: Buffer[] = [];
    let closes = 0;
    let resets = 0;
    const channels = createLocalWorkerDaemonFrameChannels({
      instanceId: 'instance-a',
      appVersion: '1.0.0-test',
      authoritativeCoreId: 'worker-core-a',
      runtime: runtime(),
      getWorkerGeneration: () => 4,
    });
    const channel = channels.open('stream-a', {
      data: (payload) => writes.push(Buffer.from(payload)),
      close: () => { closes += 1; },
      reset: () => { resets += 1; },
    }, {
      connectionScope: 'desktop-a',
      surface: 'desktop',
      grant: issueRemoteOwnerGrantClaim('desktop'),
    });

    expect(channel.write(encodeJsonFrame({
      type: 'hello',
      requestId: 'hello-client-a',
      hello: {
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        appVersion: 'desktop-test',
        clientId: 'desktop-client-a',
        requestedTopology: 'relay',
      },
    }))).toBe(true);
    await waitFor(
      () => Boolean(find(writes, 'hello-result', 'hello-client-a')),
      'Relay hello result',
    );
    const hello = find(writes, 'hello-result', 'hello-client-a')?.hello as JsonObject;
    expect(hello).toMatchObject({
      topology: 'relay',
      instanceId: 'instance-a',
      authoritativeCore: {
        id: 'worker-core-a',
        location: 'local-worker',
        generation: 4,
      },
      access: {
        topology: 'relay',
        instanceId: 'instance-a',
        clientId: 'desktop-client-a',
        transport: 'ssh',
        connectionScope: 'desktop-a',
        surface: 'desktop',
      },
    });

    expect(channel.write(encodeJsonFrame({
      type: 'request',
      requestId: 'request-health-a',
      method: 'session.console.list',
      params: {},
      idempotencyKey: null,
      expectedRevision: null,
      deadlineAt: null,
    }))).toBe(true);
    await waitFor(
      () => Boolean(find(writes, 'result', 'request-health-a')),
      'Relay request result',
    );
    expect(find(writes, 'result', 'request-health-a')).toMatchObject({
      result: { ok: true },
      revision: 7,
    });

    channel.reset('cancelled');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closes).toBe(0);
    expect(resets).toBe(0);
  });
});
