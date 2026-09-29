import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCommand } from './process.mjs';

let root;
let server;
let origin;
let probe;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'feishu-preflight-test-'));
  const generated = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem'),
  ], { stdio: 'ignore' });
  expect(generated.status).toBe(0);
  server = createServer({
    key: await readFile(join(root, 'key.pem')),
    cert: await readFile(join(root, 'cert.pem')),
  }, (request, response) => {
    if (request.url === '/timeout') return;
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `https://127.0.0.1:${server.address().port}`;
  const source = await readFile(new URL('../../deploy/linux/feishu/preflight.sh', import.meta.url), 'utf8');
  const start = source.indexOf('\n/usr/bin/curl ') + 1;
  const end = source.indexOf('\nprintf ', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  probe = source.slice(start, end).replace('https://open.feishu.cn/', '"$2"');
});

afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (root) await rm(root, { recursive: true, force: true });
});

async function check({ trusted = true, timeout = false } = {}) {
  let command = probe;
  if (trusted) command = command.replace('/usr/bin/curl ', '/usr/bin/curl --cacert "$1" ');
  if (timeout) command = command.replace('--max-time 10', '--max-time 0.1');
  return runCommand('/bin/bash', [
    '-c', 'fail() { exit 37; };\n' + command,
    'preflight-test', join(root, 'cert.pem'), origin + (timeout ? '/timeout' : '/'),
  ], { allowFailure: true, timeoutMs: 15_000 });
}

describe('Feishu preflight HTTPS reachability', () => {
  it('accepts a real HTTPS 404 response from the reachable endpoint', async () => {
    expect((await check()).code).toBe(0);
  });

  it('still rejects an untrusted TLS certificate', async () => {
    expect((await check({ trusted: false })).code).toBe(37);
  });

  it('still fails when the endpoint never responds before the deadline', async () => {
    expect((await check({ timeout: true })).code).toBe(37);
  });
});
