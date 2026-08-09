import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { providerSessionBrokerSocketPath } from '@hosts/provider-session/broker-socket-path';

import type { ServerCoreProviderInferenceBinding } from './provider-inference-broker-port';
import { createProductionServerCoreProviderInference } from './provider-inference-production';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function binding(): ServerCoreProviderInferenceBinding {
  return {
    adapterId: 'grok-build',
    instanceId: 'instance-a',
    maxConcurrency: 2,
    maxDeadlineMs: 30_000,
    maxRequestBytes: 4_096,
    maxResponseBytes: 8_192,
    method: 'POST',
    paths: ['/v1/chat/completions', '/v1/responses'],
    processId: 'process-a',
    providerId: 'xai',
    sessionId: 'session-a',
    upstreamId: 'grok-xai',
  };
}

function request(socketPath: string, path = '/v1/chat/completions'): Promise<string> {
  const body = JSON.stringify(path === '/v1/responses'
    ? { input: 'hello', model: 'grok-4.5', stream: true }
    : { messages: [{ role: 'user', content: 'hello' }], stream: true });
  return new Promise((resolve, reject) => {
    const pending = httpRequest({
      headers: {
        'content-length': Buffer.byteLength(body),
        'content-type': 'application/json',
        'x-agent-deck-deadline-ms': '20000',
        'x-agent-deck-request-id': path === '/v1/responses' ? 'request-b' : 'request-a',
      },
      method: 'POST',
      path,
      socketPath,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    pending.once('error', reject);
    pending.end(body);
  });
}

describe('production Server Core Provider inference composition', () => {
  it('keeps the real credential outside Workspace and injects it only at fixed HTTPS egress', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'adi-')));
    roots.push(root);
    const workspaceRoot = join(root, 'w');
    const brokerRoot = join(root, 'b');
    const credentialRoot = join(root, 'c');
    for (const path of [workspaceRoot, brokerRoot, credentialRoot]) {
      mkdirSync(path, { mode: 0o700 });
      chmodSync(path, 0o700);
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    writeFileSync(join(credentialRoot, 'grok-auth.json'), JSON.stringify({
      'xai::cached': {
        auth_mode: 'oauth',
        expires_at: '2099-01-01T00:00:00Z',
        key: 'REAL_TRUSTED_TOKEN',
      },
    }), { mode: 0o600 });
    const observed: Array<{ headers: Record<string, string>; url: string }> = [];
    const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
      observed.push({
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        url: String(url),
      });
      return new Response('{"choices":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const runtime = createProductionServerCoreProviderInference({
      brokerRoot,
      credentialAllowedUids: [uid],
      credentialRoot,
      currentUid: () => uid,
      fetch: fetchFn,
      nextEndpointId: () => 'endpoint-a',
      workspaceRoot,
    });
    try {
      const endpoint = await runtime.open(binding());
      const socketPath = providerSessionBrokerSocketPath(brokerRoot, endpoint.endpointId);
      await expect(request(socketPath)).resolves.toBe('{"choices":[]}');
      await expect(request(socketPath, '/v1/responses')).resolves.toBe('{"choices":[]}');
      expect(observed).toEqual([
        {
          headers: expect.objectContaining({ authorization: 'Bearer REAL_TRUSTED_TOKEN' }),
          url: 'https://cli-chat-proxy.grok.com/v1/chat/completions',
        },
        {
          headers: expect.objectContaining({ authorization: 'Bearer REAL_TRUSTED_TOKEN' }),
          url: 'https://api.x.ai/v1/responses',
        },
      ]);
      expect(JSON.stringify(binding())).not.toContain('REAL_TRUSTED_TOKEN');
    } finally {
      await runtime.close();
    }

    expect(() => createProductionServerCoreProviderInference({
      brokerRoot,
      credentialRoot: workspaceRoot,
      workspaceRoot,
    })).toThrow('disjoint');
  });
});
