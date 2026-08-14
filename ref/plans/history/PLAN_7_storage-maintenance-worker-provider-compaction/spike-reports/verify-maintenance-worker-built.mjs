// Archived PLAN_7/REVIEW_153 built-worker integrity and responsiveness harness.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';

const repo = process.cwd();
const workerName = readdirSync(resolve(repo, 'build/main'))
  .find((name) => /^maintenance-worker-[A-Za-z0-9_-]+\.js$/.test(name));
if (!workerName) throw new Error('built maintenance worker not found; run pnpm build first');
const workerPath = resolve(repo, 'build/main', workerName);
const root = mkdtempSync(join(tmpdir(), 'agent-deck-built-maintenance-'));
const dbPath = join(root, 'agent-deck.db');
const main = new Database(dbPath);
let worker;

function migration(version) {
  const prefix = `v${String(version).padStart(3, '0')}_`;
  const name = readdirSync(resolve(repo, 'src/main/store/migrations'))
    .find((entry) => entry.startsWith(prefix) && entry.endsWith('.sql'));
  if (!name) throw new Error(`migration missing: ${prefix}`);
  return readFileSync(resolve(repo, 'src/main/store/migrations', name), 'utf8');
}

function waitFor(type) {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 10_000);
    const onMessage = (message) => {
      if (message.type !== type) return;
      cleanup();
      resolveMessage(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', onError);
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
  });
}

try {
  main.pragma('journal_mode = WAL');
  main.pragma('foreign_keys = ON');
  main.pragma('trusted_schema = ON');
  for (let version = 1; version <= 40; version += 1) main.exec(migration(version));
  main.prepare(
    `INSERT INTO sessions
       (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES ('s1', 'codex-cli', '/repo', 's1', 'sdk', 'active', 'idle', 1, 1)`,
  ).run();
  main.prepare(
    `INSERT INTO events(session_id, kind, payload_json, ts, tool_use_id)
     VALUES ('s1', 'message', ?, 10, NULL)`,
  ).run(JSON.stringify({ text: 'built worker marker' }));
  main.prepare(
    `INSERT INTO file_changes
      (session_id, file_path, kind, before_blob, after_blob, before_snapshot,
       after_snapshot, metadata_json, tool_call_id, ts)
     VALUES ('s1', '/repo/a.ts', 'text', NULL, NULL, 'before', 'after', '{}', NULL, 20)`,
  ).run();
  main.exec(migration(41));

  worker = new Worker(workerPath, {
    workerData: {
      kind: 'agent-deck-storage-maintenance-v1',
      dbPath,
      restartEligible: [],
      engineOptions: { yieldDelayMs: 1, idleDelayMs: 10, errorRetryMs: 10 },
      autoCheckpointPages: 1000,
      checkpointIntervalMs: 60000,
      checkpointBacklogPages: 1000,
      checkpointRetryMs: 10,
    },
  });
  const heartbeat = { last: performance.now(), maxDrift: 0 };
  const timer = setInterval(() => {
    const now = performance.now();
    heartbeat.maxDrift = Math.max(heartbeat.maxDrift, now - heartbeat.last - 5);
    heartbeat.last = now;
  }, 5);
  await waitFor('ready');
  main.pragma('wal_autocheckpoint = 0');
  const first = waitFor('slice-result');
  worker.postMessage({ type: 'run-slice', requestId: 1 });
  const firstResult = await first;
  const second = waitFor('slice-result');
  worker.postMessage({ type: 'run-slice', requestId: 2 });
  const secondResult = await second;
  const checkpoint = waitFor('checkpoint-result');
  worker.postMessage({ type: 'checkpoint', requestId: 3 });
  const checkpointResult = await checkpoint;
  const closed = waitFor('closed');
  worker.postMessage({ type: 'close', requestId: 4 });
  await closed;
  clearInterval(timer);

  const evidence = {
    first: firstResult.tick?.result,
    second: secondResult.tick?.result,
    checkpoint: checkpointResult.checkpoint,
    eventRows: main.prepare('SELECT COUNT(*) FROM event_search_fts_v1').pluck().get(),
    hashedRows: main.prepare(
      `SELECT COUNT(*) FROM file_changes
        WHERE before_snapshot_hash IS NOT NULL AND after_snapshot_hash IS NOT NULL`,
    ).pluck().get(),
    quickCheck: main.pragma('quick_check', { simple: true }),
    foreignKeyViolations: main.pragma('foreign_key_check').length,
    maxHeartbeatDriftMs: Number(heartbeat.maxDrift.toFixed(3)),
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (
    evidence.eventRows !== 1 || evidence.hashedRows !== 1 ||
    evidence.quickCheck !== 'ok' || evidence.foreignKeyViolations !== 0
  ) process.exitCode = 1;
} finally {
  if (worker) await worker.terminate();
  main.close();
  rmSync(root, { recursive: true, force: true });
}
