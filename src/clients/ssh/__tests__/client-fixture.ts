import {
  isJsonObject,
  type HostHello,
  type JsonObject,
  type JsonValue,
} from '@contracts/index';

import { SshAgentDeckClient } from '../client';
import type { SshHostProfile } from '../types';
import {
  FakeSpawnHarness,
  FakeSshProcess,
  helloRequestId,
  makeClientHello,
  makeHostHello,
} from './fake-process';

export function profile(
  id = 'server-profile',
  topology: 'relay' | 'full' = 'full',
): SshHostProfile {
  return {
    id,
    label: id,
    topology,
    hostname: `${id}.example.test`,
    port: 22,
    username: 'agentdeck',
    identityFile: `/tmp/${id}-key`,
    knownHostsFile: `/tmp/${id}-known-hosts`,
    expectedInstanceId: topology === 'relay' ? 'relay-a' : 'server-a',
  };
}

export function makeClient(
  harness: FakeSpawnHarness,
  id = 'server-profile',
  topology: 'relay' | 'full' = 'full',
  extra: ConstructorParameters<typeof SshAgentDeckClient>[1] = {},
): SshAgentDeckClient {
  return new SshAgentDeckClient(profile(id, topology), {
    spawn: harness.spawn,
    reconnect: { maxAttempts: 0 },
    timing: { pingIntervalMs: 0, pongTimeoutMs: 0 },
    ...extra,
  });
}

export async function completeConnect(
  client: SshAgentDeckClient,
  harness: FakeSpawnHarness,
  clientId: string,
  topology: 'relay' | 'full' = 'full',
  helloOverrides: Partial<HostHello> = {},
): Promise<FakeSshProcess> {
  const connected = client.connect(makeClientHello(clientId, topology));
  const process = harness.latest;
  process.emitMessage({
    type: 'hello-result',
    requestId: helloRequestId(process),
    hello: makeHostHello(clientId, topology, helloOverrides),
  } as unknown as JsonValue);
  await connected;
  return process;
}

export function combine(...frames: Uint8Array[]): Uint8Array {
  const size = frames.reduce((total, frame) => total + frame.byteLength, 0);
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const frame of frames) {
    combined.set(frame, offset);
    offset += frame.byteLength;
  }
  return combined;
}

export function hasMessageType(
  message: JsonValue,
  type: string,
): message is JsonObject & { type: string } {
  return isJsonObject(message) && message.type === type;
}
