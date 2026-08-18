import { describe, expect, it } from 'vitest';

import {
  PROVIDER_INFERENCE_MAX_JSON_DEPTH,
  PROVIDER_INFERENCE_MAX_REQUEST_BYTES,
  parseProviderInferenceBrokerRequest,
  parseProviderInferenceBrokerResponse,
  parseProviderSessionAttachResult,
  parseProviderSessionAttachSpec,
  parseProviderSessionLaunchSpec,
  parseProviderSessionStopResult,
  parseProviderSessionSupervisorCapabilities,
} from './provider-session-container';

function launch() {
  return {
    schemaVersion: 1,
    adapterId: 'grok-build',
    brokerEndpointId: 'broker-a',
    effectiveAccess: 'selected-directory-read-write',
    launchId: 'launch-a',
    processId: 'process-a',
    providerId: 'xai',
    resourceClass: 'interactive-v1',
    runtimeId: 'grok-build-v1',
    sessionId: 'session-a',
    upstreamId: 'grok-chat',
    workingDirectory: 'repo/subdir',
  };
}

describe('provider session container contract', () => {
  it('round-trips a topology-free launch and lifecycle result', () => {
    expect(parseProviderSessionLaunchSpec(launch())).toEqual(launch());
    expect(parseProviderSessionStopResult({
      schemaVersion: 1,
      processId: 'process-a',
      runtimeHandle: 'runtime-a',
      sessionId: 'session-a',
      stopped: true,
    })).toMatchObject({ runtimeHandle: 'runtime-a', stopped: true });
    const attach = {
      schemaVersion: 1,
      processId: 'process-a',
      runtimeHandle: 'runtime-a',
      sessionId: 'session-a',
    };
    expect(parseProviderSessionAttachSpec(attach)).toEqual(attach);
    expect(parseProviderSessionAttachResult({ ...attach, attached: true }))
      .toEqual({ ...attach, attached: true });
    expect(() => parseProviderSessionAttachSpec({ ...attach, socketPath: '/run/engine.sock' }))
      .toThrow();
  });

  it('rejects host paths, runtime substitution, and widened launch fields', () => {
    expect(() => parseProviderSessionLaunchSpec({
      ...launch(), workingDirectory: '/Users/operator/secret',
    })).toThrow('workingDirectory');
    expect(() => parseProviderSessionLaunchSpec({
      ...launch(), runtimeId: 'codex-cli-v1',
    })).toThrow('runtimeId');
    for (const extra of [
      { image: 'provider:latest' },
      { mounts: ['/'] },
      { environment: { XAI_API_KEY: 'secret' } },
      { engineSocket: '/var/run/docker.sock' },
      { credential: 'reusable-token' },
    ]) {
      expect(() => parseProviderSessionLaunchSpec({ ...launch(), ...extra })).toThrow();
    }
  });

  it('accepts only an identity-free browser capability bound to the launch adapter', () => {
    const context = {
      protocolVersion: 1,
      adapterId: 'grok-build',
      lease: 'abcdefghijklmnopqrstuvwxyz012345',
      runtimeGeneration: 2,
      sourceIdentity: 'runtime-source-a',
    };
    expect(parseProviderSessionLaunchSpec({ ...launch(), browserContext: context }))
      .toMatchObject({ browserContext: context });
    expect(() => parseProviderSessionLaunchSpec({
      ...launch(), browserContext: { ...context, adapterId: 'codex-cli' },
    })).toThrow('browserContext');
    expect(() => parseProviderSessionLaunchSpec({
      ...launch(), browserContext: { ...context, sessionId: 'session-b' },
    })).toThrow('browserContext');
  });

  it('publishes only exact available or fail-closed capability states', () => {
    expect(parseProviderSessionSupervisorCapabilities({
      schemaVersion: 1,
      adapterIds: ['grok-build'],
      available: true,
      disabledReason: null,
      generation: 4,
    }).adapterIds).toEqual(['grok-build']);
    expect(parseProviderSessionSupervisorCapabilities({
      schemaVersion: 1,
      adapterIds: [],
      available: false,
      disabledReason: 'Provider session runtime is unavailable.',
      generation: 5,
    }).available).toBe(false);
    expect(() => parseProviderSessionSupervisorCapabilities({
      schemaVersion: 1,
      adapterIds: ['grok-build'],
      available: false,
      disabledReason: 'unavailable',
      generation: 1,
    })).toThrow();
  });
});

describe('provider inference broker contract', () => {
  it('accepts one bounded JSON request and JSON or SSE response', () => {
    expect(parseProviderInferenceBrokerRequest({
      schemaVersion: 1,
      body: { messages: [{ role: 'user', content: 'hello' }], stream: true },
      deadlineMs: 30_000,
      method: 'POST',
      path: '/v1/chat/completions',
      requestId: 'request-a',
    }).path).toBe('/v1/chat/completions');
    expect(parseProviderInferenceBrokerResponse({
      schemaVersion: 1,
      body: 'data: {"ok":true}\n\n',
      contentType: 'text/event-stream',
      requestId: 'request-a',
      statusCode: 200,
    }).contentType).toBe('text/event-stream');
  });

  it('rejects full URLs, path ambiguity, extra auth fields, and byte/depth abuse', () => {
    const base = {
      schemaVersion: 1,
      body: {},
      deadlineMs: 30_000,
      method: 'POST',
      path: '/v1/chat/completions',
      requestId: 'request-a',
    };
    for (const path of [
      'https://api.x.ai/v1/chat/completions',
      '/v1/../admin',
      '/v1//chat',
      '/v1/chat?credential=secret',
    ]) expect(() => parseProviderInferenceBrokerRequest({ ...base, path })).toThrow();
    expect(() => parseProviderInferenceBrokerRequest({
      ...base, authorization: 'Bearer reusable-token',
    })).toThrow();
    expect(() => parseProviderInferenceBrokerRequest({
      ...base, body: { prompt: 'x'.repeat(PROVIDER_INFERENCE_MAX_REQUEST_BYTES) },
    })).toThrow();
    let nested: unknown = {};
    for (let index = 0; index < PROVIDER_INFERENCE_MAX_JSON_DEPTH + 1; index += 1) {
      nested = { nested };
    }
    expect(() => parseProviderInferenceBrokerRequest({ ...base, body: nested })).toThrow();
  });
});
