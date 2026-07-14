import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { Worker } from 'node:worker_threads';
import { resolveConfig } from 'electron-vite';
import { build as viteBuild, type UserConfig } from 'vite';
import { describe, expect, it } from 'vitest';
import type { ContinuationCheckpoint } from '../checkpoint-schema';
import {
  CHECKPOINT_BACKGROUND_WORKER_KIND,
  type CheckpointBackgroundChunkPayload,
  type CheckpointBackgroundReadyPayload,
  type CheckpointBackgroundWorkerMessage,
} from '../checkpoint-background-worker-contract';
import { bindingAvailable } from '@main/store/__tests__/_binding-probe';
import { insertSession, makeMemoryDb } from '@main/store/__tests__/agent-deck-repos/_setup';
import { createContinuationCheckpointRepo } from '@main/store/continuation-checkpoint-repo';

const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_WIRE_BYTES = 1024 * 1024;

function checkpoint(eventId: number, revision: number): ContinuationCheckpoint {
  return {
    formatVersion: 1,
    goals: [{
      id: `goal.${revision}`,
      status: 'active',
      text: `goal at revision ${revision}`,
      priority: 100,
      evidence: [{ eventId, revision }],
    }],
    userIntent: [],
    constraints: [],
    decisions: [],
    completedWork: [],
    currentState: [],
    nextSteps: [],
    openQuestions: [],
    risks: [],
    keyFiles: [],
    commands: [],
    unresolvedErrors: [],
  };
}

async function buildProductionMain(outDir: string): Promise<string> {
  const resolved = await resolveConfig({
    configFile: resolvePath('electron.vite.config.ts'),
    logLevel: 'silent',
  }, 'build', 'production');
  const main = resolved.config?.main;
  if (!main) throw new Error('Electron Vite main config is unavailable');
  await viteBuild({
    ...(main as UserConfig),
    configFile: false,
    logLevel: 'silent',
    build: {
      ...main.build,
      outDir,
      emptyOutDir: true,
    },
  });
  const entries = readdirSync(outDir)
    .filter((name) => /^checkpoint-background-worker-(?!contract-)[\w-]+\.js$/.test(name));
  if (entries.length !== 1) {
    throw new Error(`Expected one emitted checkpoint worker, found ${entries.length}`);
  }
  return join(outDir, entries[0]);
}

function readLocalBundleClosure(entry: string): string {
  const pending = [entry];
  const visited = new Set<string>();
  const sources: string[] = [];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, 'utf8');
    sources.push(source);
    for (const match of source.matchAll(/require\(["'](\.\/[^"']+\.js)["']\)/g)) {
      pending.push(resolvePath(dirname(file), match[1]));
    }
  }
  return sources.join('\n');
}

function nextMessage(worker: Worker, timeoutMs = 15_000): Promise<CheckpointBackgroundWorkerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Timed out waiting for checkpoint worker')), timeoutMs);
    const onMessage = (message: CheckpointBackgroundWorkerMessage): void => {
      if (message.type === 'fatal') {
        finish(new Error(`Checkpoint worker fatal: ${message.error}`));
        return;
      }
      cleanup();
      resolve(message);
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (code: number): void => finish(new Error(`Checkpoint worker exited early (${code})`));
    const cleanup = (): void => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    const finish = (error: Error): void => {
      cleanup();
      reject(error);
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
  });
}

describe.skipIf(!bindingAvailable)('background checkpoint materializer worker integration', () => {
  it('runs the emitted production worker and serves a bounded chunk off the main loop', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-deck-checkpoint-background-'));
    mkdirSync(resolvePath('build'), { recursive: true });
    const bundleRoot = mkdtempSync(resolvePath('build/checkpoint-worker-test-'));
    const dbPath = join(root, 'agent-deck.db');
    const outDir = join(bundleRoot, 'main');
    const writer = makeMemoryDb(dbPath);
    writer.pragma('journal_mode = WAL');
    insertSession(writer, 'source');
    const insert = writer.prepare(
      `INSERT INTO events(session_id, kind, payload_json, ts)
       VALUES ('source', 'message', ?, 1)`,
    );
    const eventIds: number[] = [];
    writer.transaction(() => {
      for (let index = 0; index < 12_000; index += 1) {
        const info = insert.run(JSON.stringify({ role: 'user', text: `small-${index}` }));
        if (index < 2) eventIds.push(Number(info.lastInsertRowid));
      }
    })();

    let worker: Worker | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    try {
      const repo = createContinuationCheckpointRepo(writer);
      const first = repo.commit({
        sessionId: 'source',
        expectedHeadId: null,
        expectedRebuildAfterRevision: 0,
        sourceEventRevision: 1,
        sourceMaxEventId: eventIds[0],
        checkpoint: checkpoint(eventIds[0], 1),
        generatorAdapter: 'codex-cli',
        generatorModel: null,
        generatorThinking: null,
        trigger: 'test',
      });
      if (!first.ok) throw new Error(`Unexpected checkpoint conflict: ${first.reason}`);
      const second = repo.commit({
        sessionId: 'source',
        expectedHeadId: first.checkpoint.id,
        expectedRebuildAfterRevision: 0,
        sourceEventRevision: 2,
        sourceMaxEventId: eventIds[1],
        checkpoint: checkpoint(eventIds[1], 2),
        generatorAdapter: 'codex-cli',
        generatorModel: null,
        generatorThinking: null,
        trigger: 'test',
      });
      if (!second.ok) throw new Error(`Unexpected checkpoint conflict: ${second.reason}`);
      writer.prepare(`UPDATE continuation_checkpoints SET content_hash = ? WHERE id = ?`)
        .run('f'.repeat(64), second.checkpoint.id);

      const workerEntry = await buildProductionMain(outDir);
      const workerClosure = readLocalBundleClosure(workerEntry);
      expect(workerClosure).not.toMatch(/require\(["']electron["']\)/);
      expect(workerClosure).not.toContain('electron-log');
      expect(workerClosure).not.toContain('MIGRATIONS');
      expect(workerClosure).not.toContain('.setName(');

      let heartbeats = 0;
      heartbeat = setInterval(() => { heartbeats += 1; }, 1);
      worker = new Worker(workerEntry, {
        name: 'agent-deck-checkpoint-background-integration',
        workerData: {
          kind: CHECKPOINT_BACKGROUND_WORKER_KIND,
          dbPath,
          sessionId: 'source',
          maxSourceBytes: MAX_SOURCE_BYTES,
          maxRows: MAX_ROWS,
          maxWireBytes: MAX_WIRE_BYTES,
        },
      });
      const readyPromise = nextMessage(worker);
      const immediateWinner = await Promise.race([
        readyPromise.then(() => 'worker' as const),
        new Promise<'main-loop'>((resolve) => setImmediate(() => resolve('main-loop'))),
      ]);
      expect(immediateWinner).toBe('main-loop');
      const ready = await readyPromise;
      clearInterval(heartbeat);
      heartbeat = null;
      expect(heartbeats).toBeGreaterThan(0);
      expect(ready.type).toBe('ready');
      if (ready.type !== 'ready') throw new Error(`Unexpected worker response: ${ready.type}`);
      const readyPayload = JSON.parse(ready.payloadJson) as CheckpointBackgroundReadyPayload;
      expect(readyPayload.metadata).toMatchObject({
        captureRevision: 12_000,
        checkpointThroughRevision: 1,
        materializedThroughRevision: 10_001,
        sourceRows: 10_000,
        truncatedBy: 'rows',
        checkpoint: {
          id: first.checkpoint.id,
          generation: 1,
          sourceEventRevision: 1,
        },
      });

      worker.postMessage({
        type: 'build-next-chunk',
        requestId: 1,
        cursor: 0,
        coveredThroughRevision: 1,
        previous: first.checkpoint.checkpoint,
        budget: 96_000,
      });
      const chunkMessage = await nextMessage(worker);
      expect(chunkMessage.type).toBe('chunk-result');
      if (chunkMessage.type !== 'chunk-result') {
        throw new Error(`Unexpected worker response: ${chunkMessage.type}`);
      }
      const chunkPayload = JSON.parse(chunkMessage.payloadJson) as CheckpointBackgroundChunkPayload;
      expect(chunkPayload.chunk).toMatchObject({
        cursor: 0,
        firstRevision: 2,
        remainingAfter: true,
      });
      expect(chunkPayload.chunk?.nextCursor).toBeGreaterThan(0);
      expect(chunkPayload.chunk?.throughRevision).toBeGreaterThanOrEqual(2);

      const workerExit = new Promise<void>((resolve, reject) => {
        worker!.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Worker exited ${code}`)));
        worker!.once('error', reject);
      });
      worker.postMessage({ type: 'close', requestId: 2 });
      await expect(nextMessage(worker)).resolves.toEqual({ type: 'closed', requestId: 2 });
      await workerExit;
      worker = null;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      if (worker) await worker.terminate().catch(() => undefined);
      writer.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(bundleRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
