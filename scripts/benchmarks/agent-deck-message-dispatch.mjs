#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = realpathSync(resolve(dirname(scriptPath), '../..'));
const workerPath = realpathSync(join(
  dirname(scriptPath),
  'agent-deck-message-dispatch-worker.cjs',
));
const projectRequire = createRequire(join(repoRoot, 'package.json'));
const electronPath = projectRequire('electron');
const rowCounts = parseRowCounts(process.argv.slice(2));
const benchmarkRoot = realpathSync(mkdtempSync(
  join('/tmp', 'agent-deck-message-dispatch-'),
));
const reportPath = checkedChild(benchmarkRoot, 'results.json');

validateRoot();

const results = [];
try {
  for (const rowCount of rowCounts) {
    const dbPath = checkedChild(
      benchmarkRoot,
      `agent-deck-message-dispatch-${rowCount}.db`,
    );
    const sampleCounts = rowCount >= 1_000_000
      ? { repetitions: 21, fresh: 9, writes: 31 }
      : { repetitions: 31, fresh: 11, writes: 41 };
    process.stderr.write(
      `[message-dispatch-bench] ${rowCount.toLocaleString()} rows\n`,
    );
    results.push(await runWorker({
      dbPath,
      rowCount,
      ...sampleCounts,
    }));
    removeFixture(dbPath);
  }

  const report = {
    benchmark: 'agent-deck-message-dispatch',
    generatedAt: new Date().toISOString(),
    repoHead: readHead(),
    rowCounts,
    results,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(reportPath, serialized, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  const sha256 = createHash('sha256').update(serialized).digest('hex');
  process.stdout.write(`${JSON.stringify({
    reportPath,
    sha256,
    summaries: results.map(summarize),
  }, null, 2)}\n`);
} catch (error) {
  for (const rowCount of rowCounts) {
    removeFixture(join(
      benchmarkRoot,
      `agent-deck-message-dispatch-${rowCount}.db`,
    ));
  }
  if (!existsSync(reportPath)) rmdirSync(benchmarkRoot);
  throw error;
}

function parseRowCounts(args) {
  if (args.some((arg) => !arg.startsWith('--rows='))) {
    throw new Error('Only --rows=<positive integers> is supported');
  }
  const option = args.find((value) => value.startsWith('--rows='));
  const values = (option?.slice('--rows='.length) ?? '100000,1000000')
    .split(',')
    .map((value) => Number(value));
  if (
    values.length === 0 ||
    values.some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new Error('Use --rows=<positive integer>[,<positive integer>...]');
  }
  return values;
}

function validateRoot() {
  const stats = statSync(benchmarkRoot);
  const tempRoot = realpathSync('/tmp');
  if (
    !benchmarkRoot.startsWith(
      `${tempRoot}${sep}agent-deck-message-dispatch-`,
    ) ||
    !stats.isDirectory() ||
    stats.uid !== process.getuid()
  ) {
    throw new Error('Benchmark root must be a caller-owned mktemp directory');
  }
  if (existsSync(reportPath)) {
    throw new Error('Refusing to overwrite benchmark report');
  }
}

function checkedChild(root, child) {
  const target = resolve(root, child);
  if (!target.startsWith(`${root}${sep}`)) {
    throw new Error('Refusing benchmark path outside mktemp root');
  }
  return target;
}

function removeFixture(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    const target = resolve(`${dbPath}${suffix}`);
    if (!target.startsWith(`${benchmarkRoot}${sep}`)) {
      throw new Error('Refusing cleanup outside benchmark root');
    }
    rmSync(target, { force: true });
  }
}

function readHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
}

function runWorker({
  dbPath,
  rowCount,
  repetitions,
  fresh,
  writes,
}) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(`${dbPath}${suffix}`)) {
      throw new Error('Refusing existing benchmark fixture');
    }
  }
  return new Promise((resolveWorker, rejectWorker) => {
    const child = spawn(
      electronPath,
      [
        workerPath,
        benchmarkRoot,
        repoRoot,
        dbPath,
        String(rowCount),
        String(repetitions),
        String(fresh),
        String(writes),
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.on('error', rejectWorker);
    child.on('close', (code) => {
      if (code !== 0) {
        rejectWorker(new Error(
          `Electron benchmark worker failed (${code})`,
        ));
        return;
      }
      try {
        resolveWorker(JSON.parse(stdout));
      } catch {
        rejectWorker(new Error('Invalid benchmark worker output'));
      }
    });
  });
}

function summarize(result) {
  return {
    rowCount: result.rowCount,
    setupMs: result.fixture.totalMs,
    databaseBytesBefore: result.indexBuild.filesBefore.db,
    indexBuildMs: result.indexBuild.buildMs,
    indexBytes: result.indexBuild.sizeDeltaBytes,
    beforeFreshTickMedianMs:
      result.before.freshConnection.tickReadUpperBound.medianMs,
    beforeFreshTickP95Ms:
      result.before.freshConnection.tickReadUpperBound.p95Ms,
    afterFreshTickMedianMs:
      result.after.freshConnection.tickReadUpperBound.medianMs,
    afterFreshTickP95Ms:
      result.after.freshConnection.tickReadUpperBound.p95Ms,
    eligibleFingerprint: result.after.result.eligibleFingerprint,
    excludingFingerprint: result.after.result.excludingFingerprint,
    cleanup: result.cleanup,
  };
}
