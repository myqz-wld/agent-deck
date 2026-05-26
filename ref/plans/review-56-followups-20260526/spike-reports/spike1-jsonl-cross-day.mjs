// spike1: 验证 defaultCodexResumeJsonlExists 跨日 false miss 概率 + fs.readdir latency
// 对应 REVIEW_56 §F2 codex MED-1 (Batch A R2) + plan §C 类 F2 row
//
// 算法 SSOT: src/main/adapters/codex-cli/sdk-bridge/recoverer.ts:465-487
// 真实路径格式: ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<TIMESTAMP>-<threadId>.jsonl
// (plan F2 row 原描述 "<YYYY-MM-DD>/-<threadId>.jsonl" 是单层路径写错)

import { join } from 'node:path';
import {
  existsSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

// 复用 defaultCodexResumeJsonlExists 算法 (本地复制,不依赖 worktree TS 编译)
function defaultCodexResumeJsonlExists(sessionsRoot, threadId, startedAt) {
  try {
    if (!existsSync(sessionsRoot)) return false;
    const startDate = new Date(startedAt);
    for (const dayOffset of [0, -1, 1]) {
      const d = new Date(startDate.getTime() + dayOffset * 86_400_000);
      const yyyy = d.getFullYear().toString();
      const mm = (d.getMonth() + 1).toString().padStart(2, '0');
      const dd = d.getDate().toString().padStart(2, '0');
      const dayDir = join(sessionsRoot, yyyy, mm, dd);
      if (!existsSync(dayDir)) continue;
      const files = readdirSync(dayDir);
      if (files.some((f) => f.endsWith(`-${threadId}.jsonl`))) return true;
    }
    return false;
  } catch {
    return true; // fail-safe: 让 SDK 自己 try
  }
}

const root = join(tmpdir(), `spike1-codex-${process.pid}`);
function reset() {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
}

function plantJsonl(rootDir, yyyy, mm, dd, threadId, ts = '2026-05-26T00-00-00') {
  const dayDir = join(rootDir, yyyy, mm, dd);
  mkdirSync(dayDir, { recursive: true });
  const file = join(dayDir, `rollout-${ts}-${threadId}.jsonl`);
  writeFileSync(file, '');
  return file;
}

console.log('=== spike1: jsonl 跨日 false miss 实测 ===\n');

const tid = '019e5ff7-70b8-7bb3-9a29-d065ed209f40';
const jsonlDay = new Date(2026, 4, 26, 12, 0, 0); // jsonl planted at 2026-05-26

// case 0: same day (typical 99% case)
reset();
plantJsonl(root, '2026', '05', '26', tid);
const c0 = defaultCodexResumeJsonlExists(root, tid, jsonlDay.getTime());
console.log(`case 0 (startedAt same day as jsonl): ${c0 ? '✅ true MATCH' : '❌ false MISS'}`);

// case 1: jsonl 在 D 但 startedAt 在 D-1 (±1 day fallback should catch)
reset();
plantJsonl(root, '2026', '05', '26', tid);
const day_minus1 = new Date(2026, 4, 25, 23, 59, 50).getTime();
const c1 = defaultCodexResumeJsonlExists(root, tid, day_minus1);
console.log(`case 1 (startedAt D-1, jsonl D): ${c1 ? '✅ true MATCH (±1 day fallback caught)' : '❌ false MISS'}`);

// case 2: jsonl 在 D 但 startedAt 在 D+1
reset();
plantJsonl(root, '2026', '05', '26', tid);
const day_plus1 = new Date(2026, 4, 27, 0, 0, 10).getTime();
const c2 = defaultCodexResumeJsonlExists(root, tid, day_plus1);
console.log(`case 2 (startedAt D+1, jsonl D): ${c2 ? '✅ true MATCH (±1 day fallback caught)' : '❌ false MISS'}`);

// case 3: jsonl 在 D 但 startedAt 在 D-2 (algo only scans 0/-1/+1)
reset();
plantJsonl(root, '2026', '05', '26', tid);
const day_minus2 = new Date(2026, 4, 24, 12, 0, 0).getTime();
const c3 = defaultCodexResumeJsonlExists(root, tid, day_minus2);
console.log(`case 3 (startedAt D-2, jsonl D): ${c3 ? '✅ true' : '❌ false MISS — algo only covers ±1 day'}`);

// case 4: jsonl 在 D 但 startedAt 在 D+2
reset();
plantJsonl(root, '2026', '05', '26', tid);
const day_plus2 = new Date(2026, 4, 28, 12, 0, 0).getTime();
const c4 = defaultCodexResumeJsonlExists(root, tid, day_plus2);
console.log(`case 4 (startedAt D+2, jsonl D): ${c4 ? '✅ true' : '❌ false MISS — algo only covers ±1 day'}`);

// case 5: 时区边界 startedAt 23:59 local 但 jsonl 跨 UTC 进次日 (real-world DST/timezone race)
//   假设 startedAt = 2026-05-26 23:59:50 (local) → ms = same instant
//   codex CLI 写 jsonl 时如果跨 0 点 → file 落在 2026/05/27/
reset();
plantJsonl(root, '2026', '05', '27', tid); // jsonl 在第二天
const day_boundary = new Date(2026, 4, 26, 23, 59, 50).getTime();
const c5 = defaultCodexResumeJsonlExists(root, tid, day_boundary);
console.log(`case 5 (startedAt local 23:59:50 D, jsonl D+1 — UTC tz edge): ${c5 ? '✅ true MATCH (±1 day caught)' : '❌ false MISS'}`);

// === fs latency benchmark ===
console.log('\n=== fs.readdir latency benchmark (3 day scan = 3x readdir) ===');

function benchmark(numFiles, label) {
  reset();
  const dayDir = join(root, '2026', '05', '26');
  mkdirSync(dayDir, { recursive: true });
  for (let i = 0; i < numFiles; i++) {
    const fakeTid = `${i.toString(16).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`;
    writeFileSync(join(dayDir, `rollout-ts-${fakeTid}.jsonl`), '');
  }
  const targetTid = `${(numFiles - 1).toString(16).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`;
  const startedAt = new Date(2026, 4, 26, 12, 0, 0).getTime();

  for (let i = 0; i < 50; i++) defaultCodexResumeJsonlExists(root, targetTid, startedAt);

  const N = 1000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    defaultCodexResumeJsonlExists(root, targetTid, startedAt);
  }
  const t1 = performance.now();
  console.log(`${label} (${numFiles} files/day): ${((t1 - t0) / N).toFixed(3)}ms/call`);
}

benchmark(10, 'small day');
benchmark(100, 'medium day');
benchmark(1000, 'busy day');

// === recursive fs scan alternative — fallback 候选 (plan F2 修法 b) ===
console.log('\n=== recursive fs scan alternative (plan F2 修法 b 候选) ===');

function recursiveScan(sessionsRoot, threadId) {
  try {
    if (!existsSync(sessionsRoot)) return false;
    const years = readdirSync(sessionsRoot);
    for (const y of years) {
      const yPath = join(sessionsRoot, y);
      let months;
      try {
        months = readdirSync(yPath);
      } catch {
        continue;
      }
      for (const m of months) {
        const mPath = join(yPath, m);
        let days;
        try {
          days = readdirSync(mPath);
        } catch {
          continue;
        }
        for (const d of days) {
          const dPath = join(mPath, d);
          let files;
          try {
            files = readdirSync(dPath);
          } catch {
            continue;
          }
          if (files.some((f) => f.endsWith(`-${threadId}.jsonl`))) return true;
        }
      }
    }
    return false;
  } catch {
    return true;
  }
}

// Setup: medium-size tree (typical 6 month codex usage)
reset();
const years = ['2025', '2026'];
const monthsPerYear = 6;
const daysPerMonth = 30;
const filesPerDay = 5;
let totalFiles = 0;
for (const y of years) {
  for (let m = 1; m <= monthsPerYear; m++) {
    const mm = m.toString().padStart(2, '0');
    for (let d = 1; d <= daysPerMonth; d++) {
      const dd = d.toString().padStart(2, '0');
      const dayDir = join(root, y, mm, dd);
      mkdirSync(dayDir, { recursive: true });
      for (let i = 0; i < filesPerDay; i++) {
        const fakeTid = `${i.toString(16).padStart(2, '0')}${y.slice(2)}${mm}${dd}-aaaa-bbbb-cccc-dddddddddddd`;
        writeFileSync(join(dayDir, `rollout-ts-${fakeTid}.jsonl`), '');
        totalFiles++;
      }
    }
  }
}
console.log(`Planted tree: ${years.length}y × ${monthsPerYear}m × ${daysPerMonth}d × ${filesPerDay}f/day = ${totalFiles} total files`);

const targetTid = `00250101-aaaa-bbbb-cccc-dddddddddddd`; // 在 2025/01/01

for (let i = 0; i < 5; i++) recursiveScan(root, targetTid);
const N = 100;
const t0 = performance.now();
for (let i = 0; i < N; i++) recursiveScan(root, targetTid);
const t1 = performance.now();
console.log(`recursive scan (${totalFiles} files): ${((t1 - t0) / N).toFixed(3)}ms/call`);

// 对比 ±1 day 失败 path (wrong startedAt - 算法 false miss)
const wrongStartedAt = new Date(2024, 0, 1).getTime();
for (let i = 0; i < 50; i++) defaultCodexResumeJsonlExists(root, targetTid, wrongStartedAt);
const t2 = performance.now();
for (let i = 0; i < 1000; i++) {
  defaultCodexResumeJsonlExists(root, targetTid, wrongStartedAt);
}
const t3 = performance.now();
console.log(`±1 day algo (wrong startedAt, returns false): ${((t3 - t2) / 1000).toFixed(3)}ms/call`);

// cleanup
rmSync(root, { recursive: true, force: true });
console.log('\nspike1 done.');
