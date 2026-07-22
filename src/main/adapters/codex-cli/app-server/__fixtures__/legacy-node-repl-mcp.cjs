'use strict';

const { createInterface } = require('node:readline');

const SANDBOX_META_KEY = 'codex/sandbox-state-meta';
const mode = process.env.LEGACY_NODE_REPL_FIXTURE_MODE || 'legacy';
const lines = createInterface({ input: process.stdin });

lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    respond(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: {
        tools: {},
        experimental: { [SANDBOX_META_KEY]: {} },
      },
      serverInfo: { name: 'legacy-node-repl-fixture', version: '0.1.0' },
    });
    return;
  }
  if (request.method === 'tools/list') {
    respond(request.id, {
      tools: [{ name: 'js', description: 'fixture', inputSchema: { type: 'object' } }],
    });
    return;
  }
  if (request.method !== 'tools/call') return;

  const state = request.params?._meta?.[SANDBOX_META_KEY];
  if (mode === 'legacy' && !state?.sandboxPolicy) {
    error(
      request.id,
      -32602,
      "js: codex/sandbox-state-meta: missing field `sandboxPolicy`",
    );
    return;
  }
  respond(request.id, {
    content: [{ type: 'text', text: JSON.stringify({ state, code: request.params.arguments?.code }) }],
  });
});

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function error(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}
