// Archived PLAN_7/REVIEW_153 continuous-ingress and WAL high-water harness.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';

const repo = process.cwd();
const workerName = readdirSync(resolve(repo, 'build/main'))
  .find((name) => /^maintenance-worker-[A-Za-z0-9_-]+\.js$/.test(name));
if (!workerName) throw new Error('built maintenance worker not found');
const root = mkdtempSync(join(tmpdir(), 'agent-deck-built-maintenance-bench-'));
const dbPath = join(root, 'agent-deck.db');
const main = new Database(dbPath);
let worker;

function migration(version) {
  const prefix = `v${String(version).padStart(3, '0')}_`;
  const name = readdirSync(resolve(repo, 'src/main/store/migrations'))
    .find((entry) => entry.startsWith(prefix) && entry.endsWith('.sql'));
  return readFileSync(resolve(repo, 'src/main/store/migrations', name), 'utf8');
}

function waitFor(type, requestId) {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 30_000);
    const onMessage = (message) => {
      if (message.type !== type || (requestId !== undefined && message.requestId !== requestId)) return;
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

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

function maximum(values) {
  return values.reduce((max, value) => Math.max(max, value), 0);
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
  const oldEvent = main.prepare(
    `INSERT INTO events(session_id, kind, payload_json, ts, tool_use_id)
     VALUES ('s1', 'message', ?, ?, NULL)`,
  );
  const oldChange = main.prepare(
    `INSERT INTO file_changes
      (session_id, file_path, kind, before_blob, after_blob, before_snapshot,
       after_snapshot, metadata_json, tool_call_id, ts)
     VALUES ('s1', ?, 'text', NULL, NULL, ?, ?, '{}', NULL, ?)`,
  );
  main.transaction(() => {
    for (let index = 0; index < 1_000; index += 1) {
      oldEvent.run(JSON.stringify({ text: `legacy-${index} ${'event payload '.repeat(80)}` }), index);
    }
    for (let index = 0; index < 200; index += 1) {
      oldChange.run(
        `/repo/${index}.ts`,
        `before-${index}-${'a'.repeat(8 * 1024)}`,
        `after-${index}-${'b'.repeat(8 * 1024)}`,
        index,
      );
    }
  })();
  main.exec(migration(41));

  worker = new Worker(resolve(repo, 'build/main', workerName), {
    workerData: {
      kind: 'agent-deck-storage-maintenance-v1',
      dbPath,
      restartEligible: [],
      engineOptions: { yieldDelayMs: 1, idleDelayMs: 1000, errorRetryMs: 10 },
      autoCheckpointPages: 1000,
      checkpointIntervalMs: 250,
      checkpointBacklogPages: 1000,
      checkpointRetryMs: 10,
    },
  });
  await waitFor('ready');
  main.pragma('wal_autocheckpoint = 0');

  const liveEvent = main.prepare(
    `INSERT INTO events(session_id, kind, payload_json, ts, tool_use_id)
     VALUES ('s1', 'message', ?, ?, NULL)`,
  );
  const ingressDurations = [];
  const sliceDurations = [];
  const checkpointDurations = [];
  let maxWalBytes = 0;
  let running = true;
  let liveIndex = 0;
  const heartbeat = { last: performance.now(), drifts: [] };
  const heartbeatTimer = setInterval(() => {
    const now = performance.now();
    heartbeat.drifts.push(Math.max(0, now - heartbeat.last - 5));
    heartbeat.last = now;
  }, 5);
  const ingress = (async () => {
    while (running) {
      const started = performance.now();
      liveEvent.run(
        JSON.stringify({ text: `live-${liveIndex} ${'ingress payload '.repeat(40)}` }),
        10_000 + liveIndex,
      );
      ingressDurations.push(performance.now() - started);
      liveIndex += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
    }
  })();

  for (let requestId = 1; requestId <= 120; requestId += 1) {
    const resultPromise = waitFor('slice-result', requestId);
    worker.postMessage({ type: 'run-slice', requestId });
    const result = await resultPromise;
    if (result.tick?.result) sliceDurations.push(result.tick.result.durationMs);
    if (result.checkpoint) checkpointDurations.push(result.checkpoint.durationMs);
    try {
      maxWalBytes = Math.max(maxWalBytes, statSync(`${dbPath}-wal`).size);
    } catch {}
  }
  running = false;
  await ingress;
  clearInterval(heartbeatTimer);

  const closePromise = waitFor('closed', 121);
  worker.postMessage({ type: 'close', requestId: 121 });
  await closePromise;

  const evidence = {
    ingressWrites: ingressDurations.length,
    ingressMs: {
      p95: Number(percentile(ingressDurations, 0.95).toFixed(3)),
      p99: Number(percentile(ingressDurations, 0.99).toFixed(3)),
      max: Number(maximum(ingressDurations).toFixed(3)),
    },
    heartbeatDriftMs: {
      p99: Number(percentile(heartbeat.drifts, 0.99).toFixed(3)),
      max: Number(maximum(heartbeat.drifts).toFixed(3)),
    },
    workerSliceMs: {
      p95: Number(percentile(sliceDurations, 0.95).toFixed(3)),
      max: Number(maximum(sliceDurations).toFixed(3)),
    },
    workerCheckpointMs: {
      max: Number(Math.max(0, ...checkpointDurations).toFixed(3)),
    },
    maxWalBytes,
    quickCheck: main.pragma('quick_check', { simple: true }),
    foreignKeyViolations: main.pragma('foreign_key_check').length,
  };
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (
    evidence.quickCheck !== 'ok' || evidence.foreignKeyViolations !== 0 ||
    evidence.ingressMs.max >= 50 || evidence.heartbeatDriftMs.max >= 50
  ) process.exitCode = 1;
} finally {
  if (worker) await worker.terminate();
  main.close();
  rmSync(root, { recursive: true, force: true });
}
