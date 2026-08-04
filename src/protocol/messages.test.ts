import { describe, expect, it } from 'vitest';

import {
  assertHostHello,
  assertProtocolMessageEnvelope,
  ProtocolMessageError,
} from './messages';

describe('protocol message envelope', () => {
  it('accepts additive fields on a valid request envelope', () => {
    const value = {
      type: 'request',
      requestId: 'request-1',
      method: 'session.list',
      params: {},
      idempotencyKey: null,
      expectedRevision: null,
      deadlineAt: null,
      futureMinorField: true,
    };

    expect(() => assertProtocolMessageEnvelope(value)).not.toThrow();
  });

  it('rejects unknown message types and malformed revisions', () => {
    expect(() => assertProtocolMessageEnvelope({ type: 'mystery' })).toThrowError(
      expect.objectContaining<Partial<ProtocolMessageError>>({ code: 'invalid_request' }),
    );
    expect(() =>
      assertProtocolMessageEnvelope({
        type: 'subscribe',
        requestId: 'request-2',
        afterRevision: -1,
      }),
    ).toThrowError('afterRevision must be a non-negative safe integer');
  });

  it('requires request parameters to be a JSON object', () => {
    expect(() =>
      assertProtocolMessageEnvelope({
        type: 'request',
        requestId: 'request-3',
        method: 'session.list',
        params: [],
        idempotencyKey: null,
        expectedRevision: null,
        deadlineAt: null,
      }),
    ).toThrowError('params must be a JSON object');
  });

  it('requires canonical nullable request metadata', () => {
    expect(() =>
      assertProtocolMessageEnvelope({
        type: 'request',
        requestId: 'request-4',
        method: 'session.list',
        params: {},
      }),
    ).toThrowError('idempotencyKey must be null or a non-empty string');
  });

  it('validates topology-bound host identity and transport surfaces', () => {
    const hello = {
      protocolVersion: { major: 1, minor: 0 },
      appVersion: '0.1.0',
      topology: 'server-core',
      instanceId: 'tenant-a',
      authoritativeCore: {
        id: 'core-a',
        location: 'server-appliance',
        generation: null,
      },
      access: {
        kind: 'authenticated-client',
        topology: 'server-core',
        instanceId: 'tenant-a',
        clientId: 'feishu-chat-a',
        transport: 'feishu',
        accessCredentialId: 'credential-a',
        authority: 'owner-equivalent',
        surface: 'feishu-session-console',
      },
      capabilities: ['sessions.read'],
      limits: {
        maxFrameBytes: 1024,
        maxBlobBytes: 4096,
        maxConcurrentRequests: 8,
        maxQueuedEvents: 128,
      },
      eventRevision: 42,
    };

    expect(() => assertHostHello(hello)).not.toThrow();
    expect(() =>
      assertHostHello({
        ...hello,
        access: { ...hello.access, surface: 'desktop-full' },
      }),
    ).toThrowError('Invalid authenticated client access context');
  });
});
