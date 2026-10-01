import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexAppServerClient } from './client';
import { UNCONFIGURED_CODEX_CLIENT_HOST } from './client-host-port';

// Opt in with a native Codex binary; every process, provider home, and endpoint is test-owned.
const binary = process.env.AGENT_DECK_CODEX_GATEWAY_TEST_BINARY;

describe.skipIf(!binary)('native Codex Gateway recovery', () => {
  it.each([401, 503, 'truncated-stream'] as const)(
    'changes the actual request destination after %s while retaining history', async (failure) => {
      const fixture = await createFixture(binary!, failure);
      const { client, cwd, gateway, requests } = fixture;
      try {
        const thread = client.startThread({
          workingDirectory: cwd, sandboxMode: 'danger-full-access', approvalPolicy: 'never',
          skipGitRepoCheck: true, model: 'gpt-5.4', modelReasoningEffort: 'low',
          modelProvider: 'fixture', gatewayConfigOverrides: gateway('old', 'fixture'),
        });
        const threadId = await thread.ensureReady();
        expect((await thread.run(input('remember the first turn'))).finalResponse).toBe('served-old');
        fixture.failOldGateway();
        await expect(thread.run(input('failed turn'))).rejects.toThrow();

        for (const [destination, provider] of [
          ['new', 'fixture-new'], ['same-provider', 'fixture-new'], ['native', null],
        ] as const) {
          thread.stageGatewayOptions({
            model: 'gpt-5.4', effort: 'low', modelProvider: provider,
            gatewayConfigOverrides: provider ? gateway(destination, provider) : null,
          });
          expect((await thread.run(input(`retry at ${destination}`))).finalResponse)
            .toBe(`served-${destination}`);
          expect(await thread.ensureReady()).toBe(threadId);
        }

        expect(requests.map((request) => request.destination))
          .toEqual(['old', 'old', 'new', 'same-provider', 'native']);
        expect(JSON.stringify(requests[2].input)).toContain('remember the first turn');
        expect(JSON.stringify(requests[2].input)).toContain('served-old');
        expect(JSON.stringify(requests[2].input)).toContain('failed turn');
      } finally {
        await fixture.close();
      }
    }, 20_000,
  );
});

function input(text: string) {
  return [{ type: 'text' as const, text, text_elements: [] }];
}

async function createFixture(binaryPath: string, failure: number | 'truncated-stream') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-gateway-native-')));
  const codexHome = join(root, 'codex');
  const cwd = join(root, 'workspace');
  mkdirSync(codexHome);
  mkdirSync(cwd);
  const requests: Array<{ destination: string; input: unknown }> = [];
  const exits: Promise<void>[] = [];
  let failOld = false;
  const server = createServer(async (request, response) => {
    if (!request.url?.endsWith('/responses')) {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const destination = request.url.split('/')[1];
    requests.push({ destination, input: JSON.parse(body).input });
    if (failOld && destination === 'old' && typeof failure === 'number') {
      response.writeHead(failure, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Synthetic gateway failure' } }));
      return;
    }
    const id = `resp_${requests.length}`;
    const text = `served-${destination}`;
    const item = {
      id: `msg_${requests.length}`, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    };
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    const events = [
      { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0,
        item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0,
        content_index: 0, delta: text },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id, status: 'completed', output: [item],
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } },
    ];
    const selected = failOld && destination === 'old' && failure === 'truncated-stream'
      ? events.slice(0, 1) : events;
    for (const event of selected) {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const gateway = (destination: string, provider: string) => ({
    model_provider: provider,
    model_providers: { [provider]: {
      name: destination, base_url: `http://127.0.0.1:${port}/${destination}/v1`,
      wire_api: 'responses', requires_openai_auth: false, supports_websockets: false,
      request_max_retries: 0, stream_max_retries: 0,
    } },
  });
  writeFileSync(join(codexHome, 'config.toml'), [
    'model="gpt-5.4"', 'model_provider="fixture-native"', '[model_providers.fixture-native]',
    'name="fixture-native"', `base_url="http://127.0.0.1:${port}/native/v1"`,
    'wire_api="responses"', 'requires_openai_auth=false',
  ].join('\n'));
  const client = new CodexAppServerClient({
    codexPathOverride: binaryPath,
    env: { HOME: root, CODEX_HOME: codexHome, PATH: '/usr/bin:/bin', TMPDIR: root },
  }, {
    ...UNCONFIGURED_CODEX_CLIENT_HOST,
    startProcess: ({ codexPathOverride, env }) => {
      const child = spawn(codexPathOverride!, ['app-server', '--stdio'], { cwd, env, stdio: 'pipe' });
      exits.push(new Promise<void>((resolve) => child.once('close', () => resolve())));
      return child;
    },
  });
  return {
    client, cwd, gateway, requests,
    failOldGateway: () => { failOld = true; },
    close: async () => {
      client.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all(exits);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
