import { describe, expect, it } from 'vitest';

import type { HostHello, JsonValue } from '@contracts/index';

import { completeConnect, makeClient } from './__tests__/client-fixture';
import {
  FakeSpawnHarness,
  helloRequestId,
  makeClientHello,
  makeHostHello,
} from './__tests__/fake-process';
import { SSH_TEXT_LIMITS } from './limits';

const INVALID_IDENTIFIERS = [
  ['C0', 'bad\u001fidentifier'],
  ['tab', 'bad\tidentifier'],
  ['DEL', 'bad\u007fidentifier'],
  ['C1', 'bad\u0085identifier'],
  ['line separator', 'bad\u2028identifier'],
  ['paragraph separator', 'bad\u2029identifier'],
  ['UTF-8 byte overflow', '😀'.repeat(SSH_TEXT_LIMITS.requestId / 4 + 1)],
] as const;

async function connected(label: string) {
  const harness = new FakeSpawnHarness();
  const client = makeClient(harness, label);
  const process = await completeConnect(client, harness, `desktop-${label}`);
  process.takeWrittenMessages();
  return { client, harness, process };
}

function expectSanitizedTerminal(
  state: { status: string; reason: string | null },
  invalid: string,
): void {
  expect(state.status).toBe('incompatible');
  expect(state.reason).toContain('invalid');
  expect(state.reason).not.toContain(invalid);
}

describe('SSH inbound identifier validation', () => {
  it.each(INVALID_IDENTIFIERS)(
    'rejects %s ping/pong nonces before echo or heartbeat delivery',
    async (label, invalid) => {
      for (const type of ['ping', 'pong'] as const) {
        const { client, process } = await connected(`invalid-${type}-${label.replaceAll(' ', '-')}`);
        process.emitMessage({ type, nonce: invalid });
        expect(
          process
            .takeWrittenMessages()
            .some((message) => typeof message === 'object' && message !== null && 'type' in message && message.type === 'pong'),
        ).toBe(false);
        expectSanitizedTerminal(client.connectionState, invalid);
        expect(process.killedSignals).toEqual(['SIGTERM']);
        await client.close();
      }
    },
  );

  it.each(['result', 'error'] as const)(
    'rejects invalid %s requestId values before business delivery',
    async (type) => {
      for (const [label, invalid] of INVALID_IDENTIFIERS) {
        const { client, process } = await connected(
          `invalid-${type}-${label.replaceAll(' ', '-')}`,
        );
        const pending = client
          .request('system.health', {}, { requestId: 'safe-pending-request' })
          .catch((error: unknown) => error);
        process.takeWrittenMessages();
        process.emitMessage(
          type === 'result'
            ? { type, requestId: invalid, result: { shouldNotDeliver: true }, revision: 1 }
            : {
                type,
                requestId: invalid,
                error: {
                  code: 'access_denied',
                  message: 'should not deliver',
                  retryable: false,
                  currentRevision: null,
                  details: null,
                },
              },
        );
        await expect(pending).resolves.toMatchObject({ code: 'protocol_violation' });
        expectSanitizedTerminal(client.connectionState, invalid);
        expect(process.killedSignals).toEqual(['SIGTERM']);
        await client.close();
      }
    },
  );

  it('rejects unsafe HostHello identities before they enter state', async () => {
    const variants: Array<[string, string, (hello: HostHello) => HostHello]> = [
      [
        'instance',
        'bad\u0085instance',
        (hello) => ({ ...hello, instanceId: 'bad\u0085instance' }),
      ],
      [
        'core',
        '😀'.repeat(SSH_TEXT_LIMITS.coreId / 4 + 1),
        (hello) => ({
          ...hello,
          authoritativeCore: {
            ...hello.authoritativeCore,
            id: '😀'.repeat(SSH_TEXT_LIMITS.coreId / 4 + 1),
          },
        }),
      ],
      [
        'client',
        'bad\u2028client',
        (hello) => ({
          ...hello,
          access: { ...hello.access, clientId: 'bad\u2028client' },
        }),
      ],
    ];

    for (const [label, invalid, mutate] of variants) {
      const harness = new FakeSpawnHarness();
      const client = makeClient(harness, `invalid-host-${label}`);
      const connecting = client.connect(makeClientHello(`desktop-invalid-host-${label}`));
      const process = harness.latest;
      process.emitMessage({
        type: 'hello-result',
        requestId: helloRequestId(process),
        hello: mutate(makeHostHello(`desktop-invalid-host-${label}`)),
      } as unknown as JsonValue);
      await expect(connecting).rejects.toMatchObject({
        code: expect.stringMatching(/^(incompatible_handshake|protocol_violation)$/),
      });
      expect(client.connectionState.hello).toBeNull();
      expect(client.connectionState.reason).not.toContain(invalid);
      expect(process.killedSignals).toEqual(['SIGTERM']);
      await client.close();
    }
  });
});
