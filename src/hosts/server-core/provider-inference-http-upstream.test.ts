import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PROVIDER_INFERENCE_MAX_RESPONSE_BYTES } from '@contracts/index';

import type {
  ServerCoreProviderInferenceUpstreamInput,
  ServerCoreProviderInferenceUpstreamTarget,
} from './provider-inference-broker-port';
import { ServerCoreGrokCredentialFile } from './provider-inference-credential';
import { ServerCoreProviderHttpUpstream } from './provider-inference-http-upstream';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function target(
  overrides: Partial<ServerCoreProviderInferenceUpstreamTarget> = {},
): ServerCoreProviderInferenceUpstreamTarget {
  return {
    adapterId: 'grok-build',
    instanceId: 'instance-a',
    method: 'POST',
    path: '/v1/chat/completions',
    processId: 'process-a',
    providerId: 'xai',
    sessionId: 'session-a',
    upstreamId: 'grok-xai',
    ...overrides,
  };
}

function input(
  overrides: Partial<ServerCoreProviderInferenceUpstreamInput> = {},
): ServerCoreProviderInferenceUpstreamInput {
  return {
    ...target(),
    body: { messages: [{ role: 'user', content: 'hello' }], stream: true },
    deadlineMs: 30_000,
    requestId: 'request-a',
    signal: new AbortController().signal,
    ...overrides,
  };
}

function auth(token: string, expiresAt = '2099-01-01T00:00:00Z') {
  return {
    'xai::cached': {
      auth_mode: 'oauth',
      expires_at: expiresAt,
      key: token,
    },
  };
}

function upstream(
  readDocument: () => Promise<unknown>,
  fetchFn: typeof fetch,
) {
  const credentials = new ServerCoreGrokCredentialFile({
    path: '/run/secrets/agent-deck/provider-broker/grok-auth.json',
    readDocument,
  });
  return new ServerCoreProviderHttpUpstream({
    credentials,
    fetch: fetchFn,
    routes: [{
      adapterId: 'grok-build',
      origin: 'https://cli-chat-proxy.grok.com',
      paths: ['/v1/chat/completions'],
      providerId: 'xai',
      upstreamId: 'grok-xai',
    }],
  });
}

describe('ServerCore trusted Provider HTTP upstream', () => {
  it('injects a rotating credential only into the fixed HTTPS fetch', async () => {
    let current = auth('PRIVATE_TOKEN_ONE');
    const observed: Array<Record<string, string>> = [];
    const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe('https://cli-chat-proxy.grok.com/v1/chat/completions');
      observed.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return new Response('data: {"ok":true}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    const host = upstream(async () => current, fetchFn);
    await expect(host.isAvailable(target())).resolves.toBe(true);
    const first = await host.invoke(input());
    expect(first).toMatchObject({ contentType: 'text/event-stream', requestId: 'request-a' });
    current = auth('PRIVATE_TOKEN_TWO');
    await host.invoke(input({ requestId: 'request-b' }));

    expect(observed.map((headers) => headers.authorization)).toEqual([
      'Bearer PRIVATE_TOKEN_ONE',
      'Bearer PRIVATE_TOKEN_TWO',
    ]);
    expect(JSON.stringify(input())).not.toContain('PRIVATE_TOKEN');
    expect(JSON.stringify(first)).not.toContain('PRIVATE_TOKEN');
  });

  it('supports separately registered provider profiles without becoming an open proxy', async () => {
    const observed: Array<{ authorization: string | null; url: string }> = [];
    const profiles = new Map([
      ['grok-build\0xai\0grok-xai', 'XAI_PROFILE_TOKEN'],
      ['claude-code\0anthropic\0claude-messages', 'ANTHROPIC_PROFILE_TOKEN'],
      ['codex-cli\0openai\0openai-responses', 'OPENAI_PROFILE_TOKEN'],
    ]);
    const credentials = {
      async isAvailable(value: ServerCoreProviderInferenceUpstreamTarget): Promise<boolean> {
        return profiles.has([value.adapterId, value.providerId, value.upstreamId].join('\0'));
      },
      async inject(
        value: ServerCoreProviderInferenceUpstreamTarget,
        headers: Headers,
      ): Promise<void> {
        const token = profiles.get(
          [value.adapterId, value.providerId, value.upstreamId].join('\0'),
        );
        if (!token) throw new Error('provider profile is unavailable');
        headers.set('authorization', `Bearer ${token}`);
      },
    };
    const host = new ServerCoreProviderHttpUpstream({
      credentials,
      fetch: vi.fn<typeof fetch>(async (url, init) => {
        observed.push({
          authorization: new Headers(init?.headers).get('authorization'),
          url: String(url),
        });
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
      routes: [
        {
          adapterId: 'grok-build',
          origin: 'https://cli-chat-proxy.grok.com',
          paths: ['/v1/chat/completions'],
          providerId: 'xai',
          upstreamId: 'grok-xai',
        },
        {
          adapterId: 'grok-build',
          origin: 'https://api.x.ai',
          paths: ['/v1/responses'],
          providerId: 'xai',
          upstreamId: 'grok-xai',
        },
        {
          adapterId: 'claude-code',
          origin: 'https://api.anthropic.com',
          paths: ['/v1/messages'],
          providerId: 'anthropic',
          upstreamId: 'claude-messages',
        },
        {
          adapterId: 'codex-cli',
          origin: 'https://api.openai.com',
          paths: ['/v1/responses'],
          providerId: 'openai',
          upstreamId: 'openai-responses',
        },
      ],
    });

    await host.invoke(input());
    await host.invoke(input({ path: '/v1/responses' }));
    await host.invoke(input({
      adapterId: 'claude-code',
      path: '/v1/messages',
      providerId: 'anthropic',
      upstreamId: 'claude-messages',
    }));
    await host.invoke(input({
      adapterId: 'codex-cli',
      path: '/v1/responses',
      providerId: 'openai',
      upstreamId: 'openai-responses',
    }));

    expect(observed).toEqual([
      {
        authorization: 'Bearer XAI_PROFILE_TOKEN',
        url: 'https://cli-chat-proxy.grok.com/v1/chat/completions',
      },
      {
        authorization: 'Bearer XAI_PROFILE_TOKEN',
        url: 'https://api.x.ai/v1/responses',
      },
      {
        authorization: 'Bearer ANTHROPIC_PROFILE_TOKEN',
        url: 'https://api.anthropic.com/v1/messages',
      },
      {
        authorization: 'Bearer OPENAI_PROFILE_TOKEN',
        url: 'https://api.openai.com/v1/responses',
      },
    ]);
    await expect(host.invoke(input({
      adapterId: 'claude-code',
      path: '/v1/responses',
      providerId: 'anthropic',
      upstreamId: 'claude-messages',
    }))).rejects.toThrow('route was rejected');
  });

  it('fails closed for expired credentials, route substitution, and invalid upstream responses', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('not-json', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }));
    const expired = upstream(
      async () => auth('EXPIRED_TOKEN', '2020-01-01T00:00:00Z'),
      fetchFn,
    );
    await expect(expired.isAvailable(target())).resolves.toBe(false);
    await expect(expired.isAvailable(target({ path: '/v1/responses' }))).resolves.toBe(false);

    const active = upstream(async () => auth('ACTIVE_TOKEN'), fetchFn);
    await expect(active.invoke(input())).rejects.toThrow('content type');
    expect(() => new ServerCoreProviderHttpUpstream({
      credentials: new ServerCoreGrokCredentialFile({
        path: '/run/secrets/agent-deck/provider-broker/grok-auth.json',
        readDocument: async () => auth('ACTIVE_TOKEN'),
      }),
      routes: [{
        adapterId: 'grok-build',
        origin: 'http://untrusted.example',
        paths: ['/v1/chat/completions'],
        providerId: 'xai',
        upstreamId: 'grok-xai',
      }],
    })).toThrow('route');
  });

  it('rejects mixed, unrelated, or wrong-mode credential documents', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    for (const document of [
      {
        ...auth('XAI_TOKEN'),
        'openai::api_key': { auth_mode: 'api_key', key: 'OPENAI_TOKEN' },
      },
      { 'openai::api_key': { auth_mode: 'api_key', key: 'OPENAI_TOKEN' } },
      { 'xai::cached': { auth_mode: 'api_key', key: 'XAI_TOKEN' } },
    ]) {
      const host = upstream(async () => document, fetchFn);
      await expect(host.isAvailable(target())).resolves.toBe(false);
      await expect(host.invoke(input())).rejects.toThrow('unavailable');
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects an upstream body from Content-Length before allocating it', async () => {
    const host = upstream(async () => auth('ACTIVE_TOKEN'), vi.fn<typeof fetch>(async () =>
      new Response(null, {
        status: 200,
        headers: {
          'content-length': String(PROVIDER_INFERENCE_MAX_RESPONSE_BYTES + 1),
          'content-type': 'application/json',
        },
      })));
    await expect(host.invoke(input())).rejects.toThrow('exceeded');
  });

  it('reads only one canonical private credential file with exact owner/mode evidence', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'ad-cred-')));
    roots.push(root);
    const path = join(root, 'grok-auth.json');
    writeFileSync(path, JSON.stringify(auth('PRIVATE_FILE_TOKEN')), { mode: 0o600 });
    chmodSync(path, 0o600);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    const credential = new ServerCoreGrokCredentialFile({ allowedUids: [uid], path });
    await expect(credential.isAvailable(target())).resolves.toBe(true);
    chmodSync(path, 0o644);
    await expect(credential.isAvailable(target())).resolves.toBe(false);

    const linked = join(root, 'linked-auth.json');
    symlinkSync(path, linked);
    const symlinked = new ServerCoreGrokCredentialFile({ allowedUids: [uid], path: linked });
    await expect(symlinked.isAvailable(target())).resolves.toBe(false);
  });
});
