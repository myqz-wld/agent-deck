import { describe, expect, it } from 'vitest';
import { issueRemoteOwnerGrantClaim } from '@contracts/index';

import {
  assertClientHello,
  assertHostHello,
  assertProtocolMessageEnvelope,
  parseProtocolMessageEnvelope,
  ProtocolMessageError,
} from './messages';

describe('protocol message envelope', () => {
  it('accepts only the exact current ClientHello fields', () => {
    const hello = {
      protocolVersion: { major: 2, minor: 7 },
      appVersion: '0.1.0',
      clientId: 'desktop-a',
      requestedTopology: 'full',
      lastEventRevision: 4,
    } as const;
    expect(() => assertClientHello(hello)).not.toThrow();
    expect(() => assertClientHello({ ...hello, previousTopology: 'server-core' })).toThrow(
      'fields do not match the current protocol',
    );
  });

  it('rejects additive fields outside the exact current request envelope', () => {
    const value = {
      type: 'request',
      requestId: 'request-1',
      method: 'system.health',
      params: {},
      idempotencyKey: null,
      expectedRevision: null,
      deadlineAt: null,
      futureMinorField: true,
    };

    expect(() => assertProtocolMessageEnvelope(value)).toThrow(
      'fields do not match the current protocol',
    );
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
        method: 'system.health',
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
        method: 'system.health',
        params: {},
      }),
    ).toThrowError('fields do not match the current protocol');
  });

  it.each(['cancelled', 'internal_error'] as const)(
    'accepts the shared %s terminal error code',
    (code) => {
      expect(() =>
        assertProtocolMessageEnvelope({
          type: 'error',
          requestId: 'request-terminal',
          error: {
            code,
            message: 'Request reached a terminal state',
            retryable: false,
            currentRevision: null,
            details: null,
          },
        }),
      ).not.toThrow();
    },
  );

  it('validates topology-bound host identity and transport surfaces', () => {
    const hello = {
      protocolVersion: { major: 1, minor: 0 },
      appVersion: '0.1.0',
      topology: 'full',
      instanceId: 'tenant-a',
      authoritativeCore: {
        id: 'core-a',
        location: 'server-appliance',
        generation: null,
      },
      access: {
        kind: 'authenticated-client',
        topology: 'full',
        instanceId: 'tenant-a',
        clientId: 'feishu-chat-a',
        transport: 'feishu',
        connectionScope: 'credential-a',
        authority: 'owner-equivalent',
        surface: 'feishu',
        grant: issueRemoteOwnerGrantClaim('feishu'),
      },
      capabilities: ['session-console.read'],
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
        access: { ...hello.access, surface: 'desktop' },
      }),
    ).toThrowError('Invalid authenticated client access context');
    expect(() => assertHostHello({ ...hello, futureField: true })).toThrowError(
      'fields do not match the current protocol',
    );
    expect(() => assertHostHello({
      ...hello,
      protocolVersion: { ...hello.protocolVersion, patch: 1 },
    })).toThrowError('fields do not match the current protocol');
    expect(() => assertHostHello({
      ...hello,
      access: { ...hello.access, previousCredentialId: 'credential-old' },
    })).toThrowError('fields do not match the current protocol');
  });

  it('rejects retired topology and surface vocabulary without normalization', () => {
    const common = {
      protocolVersion: { major: 2, minor: 6 },
      appVersion: '0.1.0',
      clientId: 'desktop-a',
    };
    expect(() => parseProtocolMessageEnvelope({
      type: 'hello', requestId: 'retired-client',
      hello: { ...common, requestedTopology: 'server-core' },
    })).toThrow('Unknown requested topology');
  });
});
