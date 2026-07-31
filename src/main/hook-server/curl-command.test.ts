import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildHookCurlCommand } from './curl-command';
import { prepareHookRelayConfig } from './hook-relay-config';

interface ObservedRequest {
  authorization: string | undefined;
  body: string;
  url: string | undefined;
}

async function startRecordingServer(
  requests: ObservedRequest[],
): Promise<{ port: number; server: Server }> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      requests.push({
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
        url: request.url,
      });
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('test HTTP server did not expose a TCP port');
  }
  return { port: address.port, server };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function runHookCommand(
  command: string,
  cwd: string,
  input: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env: { ...process.env, ...environment },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('generated hook command exceeded its bounded test timeout'));
    }, 5_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stderr });
    });
    child.stdin.end(input);
  });
}

describe('buildHookCurlCommand', () => {
  it('uses an absolute private relay config without embedding hook authority', () => {
    const command = buildHookCurlCommand({
      relayConfigPath: "/tmp/Agent Deck's relay/sessionstart.curlrc",
      tag: 'agent-deck-hook-v2-codex-cli-sessionstart',
    });

    expect(command).toMatch(/^curl --disable --config /);
    expect(command).toContain(
      `--config '/tmp/Agent Deck'\"'\"'s relay/sessionstart.curlrc'`,
    );
    expect(command).toContain('--data-binary @-');
    expect(command).toContain('> /dev/null');
    expect(command).not.toContain('2>');
    expect(command).toContain(
      '|| true # agent-deck-hook-v2-codex-cli-sessionstart',
    );
    expect(command).not.toContain('Authorization');
    expect(command).not.toContain('Bearer');
    expect(command).toContain('X-Agent-Deck-Origin: ${AGENT_DECK_ORIGIN:-cli}');
  });

  it('suppresses duplicate cross-provider hook delivery without forwarding the body', () => {
    const command = buildHookCurlCommand({
      relayConfigPath: '/tmp/agent-deck/hook-relay/sessionstart.curlrc',
      tag: 'agent-deck-hook-v2-claude-code-sessionstart',
      skipWhenEnvironmentSet: 'GROK_HOOK_EVENT',
    });

    expect(command).toContain(
      'if [ -n "${GROK_HOOK_EVENT:-}" ]; then cat > /dev/null; else curl --disable --config',
    );
    expect(command).toContain(
      'fi || true # agent-deck-hook-v2-claude-code-sessionstart',
    );
  });

  it('rejects unsafe relay paths and ownership metadata', () => {
    expect(() =>
      buildHookCurlCommand({
        relayConfigPath: 'relative/sessionstart.curlrc',
        tag: 'agent-deck-hook',
      }),
    ).toThrow('absolute private relay config path');
    expect(() =>
      buildHookCurlCommand({
        relayConfigPath: '/tmp/sessionstart.curlrc',
        tag: 'agent-deck-hook # injected',
      }),
    ).toThrow('static ownership tag');
  });

  it('ignores a hostile default curlrc and contacts only the relay endpoint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-deck-hook-curl-'));
    const relayRequests: ObservedRequest[] = [];
    const hostileRequests: ObservedRequest[] = [];
    const relay = await startRecordingServer(relayRequests);
    const hostile = await startRecordingServer(hostileRequests);
    try {
      const token = 'c'.repeat(64);
      const relayConfigPath = prepareHookRelayConfig({
        relayRoot: join(root, 'relay'),
        adapterId: 'codex-cli',
        event: 'SessionStart',
        port: relay.port,
        token,
        route: '/hook/codex/sessionstart',
      });
      const curlHome = join(root, 'hostile-curl-home');
      mkdirSync(curlHome, { recursive: true });
      writeFileSync(
        join(curlHome, '.curlrc'),
        [
          `url = "http://127.0.0.1:${hostile.port}/stdin-exfiltration"`,
          'request = "POST"',
          '',
        ].join('\n'),
        'utf8',
      );

      const command = buildHookCurlCommand({
        relayConfigPath,
        tag: 'agent-deck-hook-v2-codex-cli-sessionstart',
      });
      const input = '{"session_id":"private-hook-payload"}\n';
      const result = await runHookCommand(command, root, input, {
        AGENT_DECK_ORIGIN: 'hostile-curlrc-regression',
        CURL_HOME: curlHome,
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
      });

      expect(result).toEqual({ code: 0, stderr: '' });
      expect(hostileRequests).toEqual([]);
      expect(relayRequests).toEqual([
        {
          authorization: `Bearer ${token}`,
          body: input,
          url: '/hook/codex/sessionstart',
        },
      ]);
    } finally {
      await Promise.allSettled([
        closeServer(relay.server),
        closeServer(hostile.server),
      ]);
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});
