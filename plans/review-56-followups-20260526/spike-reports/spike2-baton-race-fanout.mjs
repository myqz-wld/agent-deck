// spike2: 验 spawn-guards fan-out check + inFlightChildren.inc 同步段是否真 enforce baton race
// 对应 REVIEW_56 §F3 codex MED-3 (Batch B R1) / plan §C 类 F3 row
//
// SSOT 算法: src/main/agent-deck-mcp/spawn-guards.ts:96-117 (sync segment)
//             src/main/agent-deck-mcp/rate-limiter.ts:77-99 InFlightChildrenCounter
//
// REVIEW_56 §部分/未验证表 L151: "single-caller 串行不暴露,理论 race 实际不发生,低优先级"
// 本 spike 验:并发 N applySpawnGuards 是否真撞 race(JS sync 段保护铁证)

import { performance } from 'node:perf_hooks';

class InFlightChildrenCounter {
  constructor() {
    this.byParent = new Map();
  }
  inc(parentId) {
    this.byParent.set(parentId, (this.byParent.get(parentId) ?? 0) + 1);
  }
  dec(parentId) {
    const cur = this.byParent.get(parentId) ?? 0;
    if (cur <= 1) this.byParent.delete(parentId);
    else this.byParent.set(parentId, cur - 1);
  }
  get(parentId) {
    return this.byParent.get(parentId) ?? 0;
  }
  reset() {
    this.byParent.clear();
  }
}

const inFlight = new InFlightChildrenCounter();
let dbChildrenMock = 0;
const MAX_FAN_OUT = 5;

function applySpawnGuards(callerId) {
  // === SYNC 段 ===: check + inc 防穿透 (spawn-guards.ts L96-117)
  const dbChildren = dbChildrenMock;
  const inFlightCount = inFlight.get(callerId);
  const effective = dbChildren + inFlightCount;
  if (effective + 1 > MAX_FAN_OUT) {
    return { ok: false, reason: `fan-out ${effective} reached max ${MAX_FAN_OUT}` };
  }
  inFlight.inc(callerId);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      inFlight.dec(callerId);
    },
  };
}

console.log('=== spike2: baton race spawn-guards fan-out 实测 ===\n');

// === case 1: serial baton sequence (典型 hand_off baton chain) ===
console.log('--- case 1: serial baton sequence (caller release 立即 dec) ---');
inFlight.reset();
dbChildrenMock = 0;
for (let i = 1; i <= 7; i++) {
  const r = applySpawnGuards('caller-A');
  console.log(`baton ${i}: ${r.ok ? '✅ OK' : '❌ DENY (' + r.reason + ')'} (inFlight=${inFlight.get('caller-A')})`);
  if (r.ok) r.release();
}
console.log(`final inFlight=${inFlight.get('caller-A')} (should be 0)\n`);

// === case 2: N=7 parallel baton (no release - simulate await createSession 中) ===
console.log('--- case 2: N=7 parallel applySpawnGuards (no release, simulate concurrent baton 全部在 await createSession 中) ---');
inFlight.reset();
dbChildrenMock = 0;
const results = [];
for (let i = 1; i <= 7; i++) {
  const r = applySpawnGuards('caller-B');
  results.push({ i, ok: r.ok, reason: r.reason, inFlight: inFlight.get('caller-B') });
}
results.forEach((r) =>
  console.log(`spawn ${r.i}: ${r.ok ? '✅ OK' : '❌ DENY (' + r.reason + ')'} (inFlight=${r.inFlight})`),
);
const c2_ok = results.filter((r) => r.ok).length;
const c2_deny = results.filter((r) => !r.ok).length;
console.log(`stat: ${c2_ok} OK / ${c2_deny} DENY (期望 5 OK + 2 DENY,maxFanOut=${MAX_FAN_OUT})\n`);

// === case 3: race-免疫 — DB+inFlight 叠加边界 ===
console.log('--- case 3: 边界 DB=4 + inFlight 累积 ---');
inFlight.reset();
dbChildrenMock = 4;
const r1 = applySpawnGuards('caller-C');
console.log(`spawn 1 (DB=4 + inFlight=0 = 4 → +1 = 5 ≤ ${MAX_FAN_OUT}): ${r1.ok ? '✅ OK' : '❌ DENY'}`);
const r2 = applySpawnGuards('caller-C');
console.log(`spawn 2 (DB=4 + inFlight=1 = 5 → +1 = 6 > ${MAX_FAN_OUT}): ${r2.ok ? '✅ OK' : '❌ DENY'}`);

// === case 4: Promise.all 模拟真 N 并发 + await microtask gap ===
console.log('\n--- case 4: Promise.all N=12 并发 + await microtask gap (验 sync 段不让出) ---');
inFlight.reset();
dbChildrenMock = 0;

async function spawnInBaton(callerId, idx) {
  // sync 段
  const r = applySpawnGuards(callerId);
  if (!r.ok) return { idx, ok: false, reason: r.reason };
  // async 段:await createSession 模拟
  await new Promise((resolve) => setImmediate(resolve));
  r.release();
  return { idx, ok: true };
}

const promises = [];
for (let i = 1; i <= 12; i++) {
  promises.push(spawnInBaton('caller-D', i));
}
const allRes = await Promise.all(promises);
allRes.forEach((r) =>
  console.log(`baton ${r.idx}: ${r.ok ? '✅ OK' : '❌ DENY (' + r.reason + ')'}`),
);
const c4_ok = allRes.filter((r) => r.ok).length;
const c4_deny = allRes.filter((r) => !r.ok).length;
console.log(`stat: ${c4_ok} OK / ${c4_deny} DENY (期望 5 OK + 7 DENY,因 sync 段 race-free → 前 5 全 inc 占满,后 7 deny)`);
console.log(`final inFlight=${inFlight.get('caller-D')} (should be 0 — 5 个 OK 都 release 后)\n`);

// === case 5: dec 失败 (theoretical bug — handler exception 不 release 模拟) ===
console.log('--- case 5: theoretical bug — handler exception 不 release (phantom inFlight 累积) ---');
inFlight.reset();
dbChildrenMock = 0;
for (let i = 1; i <= 5; i++) {
  applySpawnGuards('caller-E'); // 不 release 模拟 handler 抛错没 finally
}
console.log(`5 个 spawn 不 release → phantom inFlight=${inFlight.get('caller-E')}`);
const r6 = applySpawnGuards('caller-E');
console.log(`spawn 6: ${r6.ok ? '✅ OK' : '❌ DENY (' + r6.reason + ') — phantom 阻塞后续合法 spawn'}`);
console.log(`(实际生产 spawn handler L101/109/329/351 多处 fanOutSlot.release() 兜底,本 case 仅证理论 risk)`);

// === case 6: baton 单序列(caller archive 之间)release 时机 ===
console.log('\n--- case 6: baton chain — caller archive 之前另一 baton 是否撞 fan-out ---');
inFlight.reset();
dbChildrenMock = 0;
// baton 1: caller A spawn child A1 → A1 还在 await createSession 中(未 archive A)
const baton1 = applySpawnGuards('caller-F');
console.log(`baton 1 (caller-F → spawn child-1): ${baton1.ok ? '✅ OK' : '❌ DENY'} (inFlight=${inFlight.get('caller-F')})`);
// 在 baton 1 await createSession 期间另一个 baton 2 来:同 caller-F (实际 baton 单 caller 不太可能,但 spawn 路径理论可能)
// dbChildren 还没 +1 (baton 1 createSession 未完成),但 inFlight=1
const baton2 = applySpawnGuards('caller-F');
console.log(`baton 2 (concurrent on caller-F): ${baton2.ok ? '✅ OK' : '❌ DENY'} (inFlight=${inFlight.get('caller-F')})`);
// 上限测:baton 1-5 都同时进入 → 第 6 个 deny
for (let i = 3; i <= 6; i++) {
  const r = applySpawnGuards('caller-F');
  console.log(`baton ${i}: ${r.ok ? '✅ OK' : '❌ DENY'} (inFlight=${inFlight.get('caller-F')})`);
}

// === micro-benchmark sync 段 latency ===
console.log('\n=== sync 段 latency (10000 calls) ===');
inFlight.reset();
dbChildrenMock = 0;
const t0 = performance.now();
const N = 10000;
for (let i = 0; i < N; i++) {
  const r = applySpawnGuards('bench');
  if (r.ok) r.release();
}
const t1 = performance.now();
console.log(`avg ${((t1 - t0) / N * 1000).toFixed(3)}μs/call (sync segment is fast — Map ops only)`);

console.log('\nspike2 done');
