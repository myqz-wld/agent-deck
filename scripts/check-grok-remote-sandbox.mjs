import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const GROK = resolve(ROOT, 'node_modules/@xai-official/grok/bin/grok');
const CANARY = 'AGENT_DECK_PRIVATE_GROK_AUTH_CANARY';
const TIMEOUT_MS = 20_000;

function completion(response, text, id = 'completion') {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of [
    {
      id,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'agent-deck-sandbox-canary',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    },
    {
      id,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'agent-deck-sandbox-canary',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    },
  ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end('data: [DONE]\n\n');
}

function toolCall(response, name, args) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of [
    {
      id: 'tool-call',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'agent-deck-sandbox-canary',
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'private-auth-read',
            type: 'function',
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
        finish_reason: null,
      }],
    },
    {
      id: 'tool-call',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'agent-deck-sandbox-canary',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    },
  ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end('data: [DONE]\n\n');
}

function readArguments(tool, credentialFile) {
  const properties = tool.function?.parameters?.properties ?? {};
  const args = {};
  for (const key of Object.keys(properties)) {
    if (['file_path', 'filename', 'path', 'target_file'].includes(key)) {
      args[key] = credentialFile;
    } else if (key === 'offset') {
      args[key] = 0;
    } else if (key === 'limit' || key === 'line_end') {
      args[key] = 20;
    } else if (key === 'line_start') {
      args[key] = 1;
    }
  }
  return args;
}

async function childExit(child) {
  let timer;
  try {
    return await Promise.race([
      new Promise((resolveExit, rejectExit) => {
        child.once('exit', (code, signal) => resolveExit({ code, signal }));
        child.once('error', rejectExit);
      }),
      new Promise((_, rejectTimeout) => {
        timer = setTimeout(() => rejectTimeout(new Error('Grok canary timed out')), TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runScenario(denyCredential) {
  const root = mkdtempSync(join(tmpdir(), 'agent-deck-grok-remote-sandbox-'));
  const home = join(root, 'home');
  const grokHome = join(home, '.grok');
  const workspace = join(root, 'workspace');
  const credentialFile = join(grokHome, 'auth.json');
  const debugFile = join(root, 'grok-debug.log');
  let server;
  let child;
  try {
    mkdirSync(grokHome, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { mode: 0o700 });
    writeFileSync(credentialFile, JSON.stringify({
      'xai::api_key': {
        auth_mode: 'api_key',
        create_time: '2026-08-01T00:00:00Z',
        expires_at: '2099-01-01T00:00:00Z',
        key: CANARY,
        user_id: 'agent-deck-canary',
      },
    }), { mode: 0o600 });

    let agentTurn = 0;
    let credentialLeaked = false;
    let toolResult = '';
    server = createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch {}
        const tools = Array.isArray(body.tools) ? body.tools : [];
        const readTool = tools.find((tool) => /read/i.test(tool?.function?.name ?? ''));
        if (!readTool) {
          completion(response, 'auxiliary complete', 'auxiliary');
          return;
        }
        agentTurn += 1;
        if (agentTurn === 1) {
          toolCall(response, readTool.function.name, readArguments(readTool, credentialFile));
          return;
        }
        credentialLeaked = raw.includes(CANARY);
        toolResult = JSON.stringify(body.messages ?? body.input ?? []);
        completion(response, 'sandbox canary complete');
      });
    });
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Canary address is invalid');

    writeFileSync(join(grokHome, 'config.toml'), [
      '[models]',
      'default = "agent-deck-sandbox-canary"',
      '[model.agent-deck-sandbox-canary]',
      'model = "agent-deck-sandbox-canary"',
      `base_url = "http://127.0.0.1:${address.port}/v1"`,
      'api_backend = "chat_completions"',
      '[cli]',
      'auto_update = false',
      '',
    ].join('\n'), { mode: 0o600 });
    writeFileSync(join(grokHome, 'sandbox.toml'), [
      '[profiles.agent-deck-remote-strict]',
      'extends = "strict"',
      'restrict_network = true',
      ...(denyCredential ? [`deny = [${JSON.stringify(credentialFile)}]`] : []),
      '',
    ].join('\n'), { mode: 0o600 });

    child = spawn(process.execPath, [
      GROK,
      '--sandbox', 'agent-deck-remote-strict',
      '--debug',
      '--debug-file', debugFile,
      '--always-approve',
      '--disable-web-search',
      '--no-subagents',
      '--no-memory',
      '--cwd', workspace,
      '-p', 'Read the requested private file.',
      '--output-format', 'json',
    ], {
      cwd: workspace,
      env: { HOME: home, GROK_HOME: grokHome, PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => { output = `${output}${chunk}`.slice(-32_768); });
    }
    const exit = await childExit(child);
    const debug = existsSync(debugFile) ? readFileSync(debugFile, 'utf8') : '';
    return {
      ...exit,
      credentialLeaked,
      toolResult,
      diagnostics: `${output}\n${debug}`.replaceAll(CANARY, '[CANARY]'),
    };
  } finally {
    if (child && child.exitCode === null) child.kill('SIGTERM');
    if (server) await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(root, { recursive: true, force: true });
  }
}

if (!existsSync(GROK)) throw new Error('Pinned Grok wrapper is unavailable');

const exposed = await runScenario(false);
if (exposed.code !== 0 || (!exposed.credentialLeaked && !exposed.toolResult.includes(CANARY))) {
  throw new Error(`Pinned Grok no longer proves same-process auth exposure: ${exposed.diagnostics}`);
}

const denied = await runScenario(true);
if (denied.code === 0 || !/not signed in|operation not permitted|permission denied/i.test(
  denied.diagnostics,
)) {
  throw new Error(`Pinned Grok no longer proves auth-deny startup failure: ${denied.diagnostics}`);
}

process.stdout.write(
  '[grok-remote-sandbox] confirmed: auth is tool-readable unless denying it also breaks startup\n',
);
