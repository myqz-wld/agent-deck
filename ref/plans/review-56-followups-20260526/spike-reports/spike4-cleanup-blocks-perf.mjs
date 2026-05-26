// spike4: 验 cleanupBlocksReferences 全表扫 + N+1 在 10k+ task 表 latency
// 对应 REVIEW_56 §F11 claude M-3 (Batch C R1) / plan §C 类 F11 row
//
// SSOT: src/main/store/task-repo.ts:544-570 cleanupBlocksReferences
// 算法: SELECT id, blocks, blocked_by FROM tasks (全表) → for survivor JSON.parse + filter
//        → UPDATE 仅命中部分 (L554 "仅当真发生变化才 UPDATE 避免 N+1 写放大")
//
// 限制: worktree 没 node_modules (Node 24 ABI vs Electron 33 项目 binding 不兼容,
// CHANGELOG_42 教训),用 pure JS 模拟 in-memory + extrapolation 估算真 SQL latency

import { performance } from 'node:perf_hooks';

// 复刻 cleanupBlocksReferences (pure JS, in-memory Map 模拟 SQL SELECT + UPDATE)
function cleanupBlocksReferencesMock(tasks, deletedIds) {
  let updateCount = 0;
  // 模拟 SELECT id, blocks, blocked_by FROM tasks (全表)
  for (const [id, t] of tasks) {
    const newBlocks = t.blocks.filter((x) => !deletedIds.has(x));
    const newBlockedBy = t.blocked_by.filter((x) => !deletedIds.has(x));
    // 仅当真发生变化才 UPDATE (避免 N+1 写放大,SSOT L554)
    if (newBlocks.length !== t.blocks.length || newBlockedBy.length !== t.blocked_by.length) {
      t.blocks = newBlocks;
      t.blocked_by = newBlockedBy;
      updateCount++;
    }
  }
  return updateCount;
}

function seedTasks(N, avgBlocksPerTask = 2) {
  const tasks = new Map();
  for (let i = 0; i < N; i++) {
    tasks.set(`task-${i}`, { id: `task-${i}`, blocks: [], blocked_by: [] });
  }
  const ids = Array.from(tasks.keys());
  for (const id of ids) {
    const t = tasks.get(id);
    const numBlocks = Math.floor(Math.random() * avgBlocksPerTask * 2);
    for (let j = 0; j < numBlocks; j++) {
      const target = ids[Math.floor(Math.random() * ids.length)];
      if (target !== id) t.blocks.push(target);
    }
  }
  return tasks;
}

console.log('=== spike4: cleanupBlocksReferences pure JS latency 估算 ===\n');

console.log('--- scale test: deletedIds=10 (typical case) ---');
const SIZES = [100, 1000, 10000, 50000, 100000];
for (const N of SIZES) {
  const tasks = seedTasks(N);
  const ids = Array.from(tasks.keys());
  const deletedIds = new Set();
  for (let i = 0; i < 10; i++) {
    deletedIds.add(ids[Math.floor(Math.random() * ids.length)]);
  }

  for (let i = 0; i < 3; i++) cleanupBlocksReferencesMock(tasks, deletedIds);

  const ITER = N >= 50000 ? 10 : 50;
  const t0 = performance.now();
  for (let i = 0; i < ITER; i++) {
    cleanupBlocksReferencesMock(tasks, deletedIds);
  }
  const t1 = performance.now();
  console.log(`N=${N.toString().padStart(6)} tasks → ${((t1 - t0) / ITER).toFixed(2)}ms/call (pure JS, no SQLite)`);
}

console.log('\n--- deletedIds size sweep (N=10000 fixed, cascade scenario) ---');
const N = 10000;
const tasks = seedTasks(N);
const ids = Array.from(tasks.keys());

for (const numDeleted of [1, 10, 100, 1000, 5000]) {
  const deletedIds = new Set();
  for (let i = 0; i < numDeleted; i++) {
    deletedIds.add(ids[Math.floor(Math.random() * ids.length)]);
  }

  for (let i = 0; i < 3; i++) {
    const fresh = new Map();
    for (const [id, t] of tasks) fresh.set(id, { id, blocks: [...t.blocks], blocked_by: [...t.blocked_by] });
    cleanupBlocksReferencesMock(fresh, deletedIds);
  }

  const ITER = 20;
  const t0 = performance.now();
  for (let i = 0; i < ITER; i++) {
    const fresh = new Map();
    for (const [id, t] of tasks) fresh.set(id, { id, blocks: [...t.blocks], blocked_by: [...t.blocked_by] });
    cleanupBlocksReferencesMock(fresh, deletedIds);
  }
  const t1 = performance.now();
  console.log(`N=${N} tasks, deletedIds=${numDeleted.toString().padStart(4)} → ${((t1 - t0) / ITER).toFixed(2)}ms/call (含 copy overhead)`);
}

console.log('\n=== extrapolation 估算真 SQLite latency (better-sqlite3 sync API) ===');
console.log('实测 pure JS in-memory 已 baseline,真 SQLite 额外加:');
console.log('- SELECT 全表: ~0.001-0.005ms/row (better-sqlite3 row mode 10k = ~10-50ms)');
console.log('- JSON.parse 每 row: ~0.001ms (10k row = ~10ms)');
console.log('- UPDATE 命中部分: ~0.05-0.1ms/UPDATE (typical 10 deletedIds 触发几个 UPDATE)');
console.log('- tx commit overhead: ~5-10ms');
console.log('');
console.log('真 SQLite 估算 latency for typical case (N=10000, deletedIds=10):');
console.log('  SELECT 10k = ~30ms + parse 10k = ~10ms + UPDATE 几次 = ~1ms + tx ~5ms ≈ 50ms');
console.log('真 SQLite 估算 latency for stress case (N=100000, deletedIds=10):');
console.log('  SELECT 100k = ~300ms + parse 100k = ~100ms + UPDATE 几次 = ~1ms + tx ~5ms ≈ 400ms');
console.log('');
console.log('plan §C 类 F11 决策点: latency > 100ms → 加 retention GC / JSON1 ext;否则 dismiss');

console.log('\nspike4 done');
