#!/usr/bin/env node
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
import { spawn } from 'node:child_process';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = realpathSync(resolve(dirname(scriptPath), '../..'));
const workerPath = realpathSync(join(dirname(scriptPath), 'token-usage-daily-worker.cjs'));
const projectRequire = createRequire(join(repoRoot, 'package.json'));
const electronPath = projectRequire('electron');
const rowCounts = parseRowCounts(process.argv.slice(2));
const tempPrefix = join('/tmp', 'agent-deck-token-daily-');
const benchmarkRoot = realpathSync(mkdtempSync(tempPrefix));
const reportPath = join(benchmarkRoot, 'results.json');

if (!statSync(benchmarkRoot).isDirectory() || statSync(benchmarkRoot).uid !== process.getuid()) {
  throw new Error('Benchmark root must be a caller-owned mktemp directory');
}
if (existsSync(reportPath)) throw new Error('Refusing to overwrite benchmark report');

const results = [];
try {
  for (const rowCount of rowCounts) {
    const dbPath = checkedChild(benchmarkRoot, `token-usage-${rowCount}.db`);
    const repetitions = rowCount >= 5_000_000 ? 5 : 7;
    process.stderr.write(
      `[token-daily-bench] ${rowCount.toLocaleString()} rows, ${repetitions} samples\n`,
    );
    const result = await runWorker({
      dbPath,
      repetitions,
      rowCount,
    });
    results.push(result);
    removeFixture(dbPath);
  }

  const report = {
    benchmark: 'token-usage-daily',
    generatedAt: new Date().toISOString(),
    repoHead: process.env.TOKEN_USAGE_BENCH_HEAD ?? null,
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
    summaries: results.map(({ rowCount, raw, rollup }) => ({
      rowCount,
      rawFreshMedianMs: raw.freshConnection.medianMs,
      rawFreshP95Ms: raw.freshConnection.p95Ms,
      rawWarmMedianMs: raw.warm.medianMs,
      rawWarmP95Ms: raw.warm.p95Ms,
      projectionBuildMs: rollup.buildMs,
      projectionFreshMedianMs: rollup.freshConnection.medianMs,
      projectionFreshP95Ms: rollup.freshConnection.p95Ms,
      projectionWarmMedianMs: rollup.warm.medianMs,
      projectionWarmP95Ms: rollup.warm.p95Ms,
      resultRows: raw.resultRows,
      resultFingerprint: raw.resultFingerprint,
    })),
  }, null, 2)}\n`);
} catch (error) {
  for (const rowCount of rowCounts) {
    removeFixture(join(benchmarkRoot, `token-usage-${rowCount}.db`));
  }
  if (!existsSync(reportPath)) {
    rmdirSync(benchmarkRoot);
  }
  throw error;
}

function parseRowCounts(args) {
  const option = args.find((value) => value.startsWith('--rows='));
  const values = (option?.slice('--rows='.length) ?? '100000,1000000,5000000')
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

function runWorker({ dbPath, repetitions, rowCount }) {
  if (existsSync(dbPath) || existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`)) {
    throw new Error(`Refusing existing benchmark fixture for ${rowCount} rows`);
  }
  return new Promise((resolveWorker, rejectWorker) => {
    const child = spawn(
      electronPath,
      [workerPath, benchmarkRoot, repoRoot, dbPath, String(rowCount), String(repetitions)],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on('error', rejectWorker);
    child.on('close', (code) => {
      if (code !== 0) {
        rejectWorker(new Error(
          `Electron benchmark worker failed (${code}): ${stderr.slice(-2000)}`,
        ));
        return;
      }
      try {
        resolveWorker(JSON.parse(stdout));
      } catch (error) {
        rejectWorker(new Error(
          `Invalid benchmark worker output: ${String(error)} ${stdout.slice(-1000)}`,
        ));
      }
    });
  });
}
