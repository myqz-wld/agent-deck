import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Exercise the actual bundled ws codec, including its optional native-addon selection. */
export function verifyFeishuWebSocketBundle(
  bundle = resolve(repoRoot, 'build/linux-headless/feishu/index.mjs'),
) {
  const source = readFileSync(bundle, 'utf8');
  const marker = 'const entrypointArgv = process.argv.slice(2);';
  const start = source.indexOf(marker);
  const end = source.indexOf('\n);', start) + 3;
  if (start < 0 || source.lastIndexOf(marker) !== start || end <= start) {
    throw new Error('Feishu bundle entrypoint boundary changed; update the transport check');
  }
  // Disable only the service invocation; preserve every dependency and lazy definition.
  const definitions = source.slice(0, start) + source.slice(end);
  const root = mkdtempSync(join(dirname(bundle), '.transport-check-'));
  try {
    const probe = join(root, 'transport.mjs');
    writeFileSync(probe, `${definitions}
import { strict as transportAssert } from 'node:assert';
import { once as transportOnce } from 'node:events';
const TransportSender = requireSender();
const TransportReceiver = requireReceiver();
for (const length of [0, 31, 32, 47, 48, 49, 125, 126, 1024, 65536]) {
  const original = Buffer.from(Array.from({ length }, (_, i) => i % 251));
  const data = Buffer.from(original);
  const frames = TransportSender.frame(data, {
    fin: true, opcode: 2, rsv1: false, mask: true, readOnly: true,
    generateMask: (mask) => mask.set([0x12, 0x34, 0x56, 0x78]),
  });
  transportAssert.equal(frames[0][1] & 0x80, 0x80, 'client frame must be masked');
  const receiver = new TransportReceiver({ isServer: true, binaryType: 'nodebuffer' });
  const messages = [];
  receiver.on('message', (value) => messages.push(value));
  const finished = transportOnce(receiver, 'finish');
  receiver.end(Buffer.concat(frames));
  await finished;
  transportAssert.equal(messages.length, 1);
  transportAssert.deepEqual(messages[0], original);
  transportAssert.deepEqual(data, original, 'read-only framing must preserve caller bytes');
}
process.stdout.write('Feishu bundled WebSocket framing check passed.\\n');
`, { mode: 0o600 });
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.WS_NO_BUFFER_UTIL;
    execFileSync(process.execPath, [probe], {
      cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyFeishuWebSocketBundle();
}
