import type { JsonObject } from '@contracts/index';
import { describe, expect, it, vi } from 'vitest';

import {
  createHost,
  createRuntime,
  findMessage,
  hello,
  request,
  sshAccess,
  TestDuplex,
  waitFor,
} from './connection-test-helpers';
import { MAX_DAEMON_TIMER_DELAY_MS } from './request-scheduler';

const UNSAFE_IDENTIFIER_CHARACTERS = [
  ['NUL', '\0'],
  ['CR', '\r'],
  ['LF', '\n'],
  ['C0', '\u001f'],
  ['DEL', '\u007f'],
  ['C1', '\u0085'],
  ['line separator', '\u2028'],
  ['paragraph separator', '\u2029'],
] as const;

describe('daemon protocol identifier validation', () => {
  it('rejects forbidden revisions and oversized idempotency keys', async () => {
    const execute = vi.fn(async () => ({ result: { ok: true }, revision: 0 }));
    const now = 10_000;
    const host = createHost(
      createRuntime({
        supportedMethods: ['session.console.list', 'session.send'],
        execute,
      }),
      {},
      () => now,
    );
    await host.start();
    const stream = new TestDuplex();
    host.accept({ stream, createAccessContext: sshAccess });
    stream.feed(hello('request-validation'));
    await waitFor(() => Boolean(findMessage(stream, 'hello-result')), 'hello');

    stream.feed({ ...request('revision-none'), expectedRevision: 1 });
    stream.feed({
      ...request('idempotency-too-long', 'session.send'),
      idempotencyKey: 'é'.repeat(257),
    });
    for (const requestId of ['revision-none', 'idempotency-too-long']) {
      await waitFor(() => Boolean(findMessage(stream, 'error', requestId)), requestId);
      expect(findMessage(stream, 'error', requestId)).toMatchObject({
        error: { code: 'invalid_request' },
      });
    }
    expect(execute).not.toHaveBeenCalled();
    await host.stop();
  });

  it('accepts deadlines beyond one Node timer horizon by chunking the wait', async () => {
    const execute = vi.fn(async () => ({ result: { ok: true }, revision: 1 }));
    const now = 10_000;
    const host = createHost(createRuntime({ execute }), {}, () => now);
    await host.start();
    const stream = new TestDuplex();
    host.accept({ stream, createAccessContext: sshAccess });
    stream.feed(hello('long-deadline'));
    await waitFor(() => Boolean(findMessage(stream, 'hello-result')), 'hello');

    stream.feed({
      ...request('long-deadline-request'),
      deadlineAt: now + MAX_DAEMON_TIMER_DELAY_MS + 1,
    });
    await waitFor(
      () => Boolean(findMessage(stream, 'result', 'long-deadline-request')),
      'long deadline result',
    );
    expect(execute).toHaveBeenCalledOnce();
    await host.stop();
  });

  it('rejects empty and oversized request ids without reflecting them', async () => {
    const execute = vi.fn(async () => ({ result: { ok: true }, revision: 0 }));
    const host = createHost(createRuntime({ execute }));
    await host.start();

    for (const [label, invalidId, expectSafeError] of [
      ['empty', '', false],
      ['oversized', 'r'.repeat(257), true],
    ] as const) {
      const stream = new TestDuplex();
      const connection = host.accept({ stream, createAccessContext: sshAccess });
      stream.feed(hello(`request-id-${label}`));
      await waitFor(() => Boolean(findMessage(stream, 'hello-result')), `${label} hello`);
      stream.feed(request(invalidId));
      const reason = await connection.whenClosed();
      if (expectSafeError) {
        expect(findMessage(stream, 'error', 'invalid-correlation-id')).toMatchObject({
          error: { code: 'invalid_request' },
        });
      } else {
        expect(reason).toBe('malformed-frame');
        expect(findMessage(stream, 'error')).toBeUndefined();
      }
      expect(stream.decoded()).not.toContainEqual(
        expect.objectContaining({ requestId: invalidId }),
      );
    }

    expect(execute).not.toHaveBeenCalled();
    await host.stop();
  });

  it('rejects actual control and line-separator characters before executor dispatch', async () => {
    const execute = vi.fn(async () => ({ result: { ok: true }, revision: 0 }));
    const host = createHost(createRuntime({ execute }));
    await host.start();

    for (const [label, character] of UNSAFE_IDENTIFIER_CHARACTERS) {
      const stream = new TestDuplex();
      const connection = host.accept({ stream, createAccessContext: sshAccess });
      stream.feed(hello(`unsafe-request-${label.replace(' ', '-')}`));
      await waitFor(() => Boolean(findMessage(stream, 'hello-result')), `${label} hello`);
      stream.feed(request(`unsafe${character}request`));
      await connection.whenClosed();
      expect(findMessage(stream, 'error', 'invalid-correlation-id')).toMatchObject({
        error: { code: 'invalid_request' },
      });
    }

    expect(execute).not.toHaveBeenCalled();
    await host.stop();
  });

  it('rejects unsafe idempotency keys without dispatching or closing the connection', async () => {
    const execute = vi.fn(async () => ({ result: { ok: true }, revision: 0 }));
    const host = createHost(
      createRuntime({ supportedMethods: ['session.create'], execute }),
    );
    await host.start();
    const stream = new TestDuplex();
    const connection = host.accept({ stream, createAccessContext: sshAccess });
    stream.feed(hello('unsafe-idempotency'));
    await waitFor(() => Boolean(findMessage(stream, 'hello-result')), 'hello');

    for (const [index, [label, character]] of UNSAFE_IDENTIFIER_CHARACTERS.entries()) {
      const requestId = `unsafe-key-${index}`;
      stream.feed({
        ...request(requestId, 'session.create'),
        idempotencyKey: `key${character}value`,
      });
      await waitFor(() => Boolean(findMessage(stream, 'error', requestId)), label);
      expect(findMessage(stream, 'error', requestId)).toMatchObject({
        error: { code: 'invalid_request' },
      });
    }

    expect(connection.isClosed).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    await host.stop();
  });

  it('applies the same rule to every reflected client correlation field', async () => {
    const execute = vi.fn(async () => ({ result: { ok: true }, revision: 0 }));
    const subscribe = vi.fn(async () => ({ close: () => undefined }));
    const host = createHost(createRuntime({ execute, subscribe }));
    await host.start();

    const invalidHello = new TestDuplex();
    const invalidHelloAccess = vi.fn(sshAccess);
    const helloConnection = host.accept({
      stream: invalidHello,
      createAccessContext: invalidHelloAccess,
    });
    invalidHello.feed({ ...hello('invalid-hello'), requestId: 'hello\nrequest' });
    await helloConnection.whenClosed();
    expect(invalidHelloAccess).not.toHaveBeenCalled();
    expect(findMessage(invalidHello, 'error', 'invalid-correlation-id')).toBeDefined();

    const cases: ReadonlyArray<{ label: string; message: JsonObject }> = [
      {
        label: 'subscribe requestId',
        message: { type: 'subscribe', requestId: 'subscribe\rrequest', afterRevision: 0 },
      },
      {
        label: 'cancel requestId',
        message: {
          type: 'cancel',
          requestId: 'cancel\u0085request',
          targetRequestId: 'target-safe',
        },
      },
      {
        label: 'cancel targetRequestId',
        message: {
          type: 'cancel',
          requestId: 'cancel-safe',
          targetRequestId: 'target\u2029request',
        },
      },
      { label: 'ping nonce', message: { type: 'ping', nonce: 'ping\u007fnonce' } },
    ];

    for (const [index, { label, message }] of cases.entries()) {
      const stream = new TestDuplex();
      const connection = host.accept({ stream, createAccessContext: sshAccess });
      stream.feed(hello(`correlation-${index}`));
      await waitFor(() => Boolean(findMessage(stream, 'hello-result')), `${label} hello`);
      stream.feed(message);
      await connection.whenClosed();
      expect(findMessage(stream, 'error', 'invalid-correlation-id'), label).toBeDefined();
      expect(findMessage(stream, 'pong'), label).toBeUndefined();
    }

    expect(subscribe).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await host.stop();
  });
});
