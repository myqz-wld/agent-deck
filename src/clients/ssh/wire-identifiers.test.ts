import { describe, expect, it } from 'vitest';

import type { JsonValue } from '@contracts/index';

import { SshAgentDeckClient } from './client';
import { SSH_TEXT_LIMITS, utf8ByteLength } from './limits';
import { completeConnect, hasMessageType, makeClient, profile } from './__tests__/client-fixture';
import {
  FakeSpawnHarness,
  helloRequestId,
  makeClientHello,
  makeHostHello,
} from './__tests__/fake-process';

const CONTROLS = ['\t', '\u0001', '\u007f', '\u0085', '\u2028', '\u2029'] as const;

describe('SSH wire identifier byte and control bounds', () => {
  it('uses UTF-8 byte ceilings for request and idempotency identifiers', async () => {
    const harness = new FakeSpawnHarness();
    const client = makeClient(harness, 'wire-byte-bounds');
    const process = await completeConnect(client, harness, 'desktop-wire-byte-bounds');
    process.takeWrittenMessages();

    const requestId = '😀'.repeat(SSH_TEXT_LIMITS.requestId / 4);
    expect(utf8ByteLength(requestId)).toBe(SSH_TEXT_LIMITS.requestId);
    const accepted = client.request('system.health', {}, { requestId });
    expect(process.takeWrittenMessages()).toContainEqual(
      expect.objectContaining({ type: 'request', requestId }),
    );
    process.emitMessage({
      type: 'result',
      requestId,
      result: { ok: true },
      revision: 1,
    });
    await accepted;
    await expect(
      client.request('system.health', {}, { requestId: `${requestId}😀` }),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    const idempotencyKey = '😀'.repeat(SSH_TEXT_LIMITS.idempotencyKey / 4);
    expect(utf8ByteLength(idempotencyKey)).toBe(SSH_TEXT_LIMITS.idempotencyKey);
    const mutation = client.request(
      'session.send',
      { sessionId: 'session-a', text: 'Inspect' },
      { requestId: 'mutation-byte-boundary', idempotencyKey },
    );
    expect(process.takeWrittenMessages()).toContainEqual(
      expect.objectContaining({ type: 'request', idempotencyKey }),
    );
    process.emitMessage({
      type: 'result',
      requestId: 'mutation-byte-boundary',
      result: { ok: true },
      revision: 2,
    });
    await mutation;
    await expect(
      client.request(
        'session.send',
        { sessionId: 'session-a', text: 'Inspect' },
        { requestId: 'mutation-too-large', idempotencyKey: `${idempotencyKey}😀` },
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await client.close();
  });

  it('rejects the daemon control set locally without writing or poisoning the channel', async () => {
    const harness = new FakeSpawnHarness();
    const client = makeClient(harness, 'wire-controls');
    const process = await completeConnect(client, harness, 'desktop-wire-controls');
    process.takeWrittenMessages();

    for (const control of CONTROLS) {
      await expect(
        client.request('system.health', {}, { requestId: `bad${control}request` }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      await expect(
        client.request(
          'session.send',
          { sessionId: 'session-a', text: 'Inspect' },
          { requestId: `mutation-${control.codePointAt(0)}`, idempotencyKey: `bad${control}key` },
        ),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(process.takeWrittenMessages().filter((message) => hasMessageType(message, 'request'))).toEqual(
      [],
    );
    expect(client.connectionState.status).toBe('connected');
    await client.close();
  });

  it('applies the same byte/control rules before spawning for trust identities', async () => {
    const valid = profile('profile-byte-bounds');
    valid.label = '😀'.repeat(SSH_TEXT_LIMITS.profileLabel / 4);
    expect(() => new SshAgentDeckClient(valid)).not.toThrow();
    valid.label += '😀';
    expect(() => new SshAgentDeckClient(valid)).toThrowError('UTF-8 bytes');

    const byteBoundedProfile = profile('profile-id-host');
    byteBoundedProfile.id = '😀'.repeat(SSH_TEXT_LIMITS.profileId / 4);
    expect(() => new SshAgentDeckClient(byteBoundedProfile)).not.toThrow();
    byteBoundedProfile.id += '😀';
    expect(() => new SshAgentDeckClient(byteBoundedProfile)).toThrowError('UTF-8 bytes');

    for (const control of CONTROLS) {
      const invalid = profile('profile-control');
      invalid.label = `bad${control}label`;
      expect(() => new SshAgentDeckClient(invalid)).toThrowError('wire control');
    }

    const harness = new FakeSpawnHarness();
    const client = makeClient(harness, 'client-control');
    for (const control of CONTROLS) {
      await expect(
        client.connect(makeClientHello(`bad${control}client`)),
      ).rejects.toMatchObject({ code: 'incompatible_handshake' });
    }
    expect(harness.calls).toHaveLength(0);
    expect(client.lastEventRevision).toBe(0);
    await client.close();

    const clientBytesHarness = new FakeSpawnHarness();
    const clientBytes = makeClient(clientBytesHarness, 'client-byte-bound');
    const clientId = '😀'.repeat(SSH_TEXT_LIMITS.clientId / 4);
    const connected = clientBytes.connect(makeClientHello(clientId));
    const process = clientBytesHarness.latest;
    process.emitMessage({
      type: 'hello-result',
      requestId: helloRequestId(process),
      hello: makeHostHello(clientId),
    } as unknown as JsonValue);
    await connected;
    await clientBytes.close();

    const oversizedHarness = new FakeSpawnHarness();
    const oversizedClient = makeClient(oversizedHarness, 'client-too-large');
    await expect(
      oversizedClient.connect(makeClientHello(`${clientId}😀`)),
    ).rejects.toMatchObject({ code: 'incompatible_handshake' });
    expect(oversizedHarness.calls).toHaveLength(0);
    await oversizedClient.close();
  });
});
