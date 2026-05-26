// spike3: 验 archive-plan.ts resolveCallerCwdDeps fail-open warn 是否 surface 到 ok return.warnings
// 对应 REVIEW_56 §F9 claude M2 (Batch B R1) / plan §C 类 F9 row
//
// SSOT: src/main/agent-deck-mcp/tools/handlers/archive-plan.ts:95-142 (resolveCallerCwdDeps)
//        src/main/agent-deck-mcp/tools/handlers/archive-plan.ts:215-222 (ok return.warnings)
//        src/main/agent-deck-mcp/tools/handlers/archive-plan-impl.ts:439 (impl warnings 数组)
//
// 修法当前 (P5 R1): handler catch console.warn + return {} 退化, NOT 接进 result.warnings

// 本地复刻 resolveCallerCwdDeps (handler-side)
function resolveCallerCwdDeps(callerSessionId, mockSessionRepo) {
  if (callerSessionId === '__external__') return {};
  let row = null;
  try {
    row = mockSessionRepo.get(callerSessionId);
  } catch (err) {
    console.warn(
      `[archive-plan] sessionRepo.get(${callerSessionId}) threw — falling back to DEFAULT_DEPS (cwd=process.cwd, marker=null)`,
      err.message,
    );
    return {}; // ← 关键: 返空 deps, 没把 warn 加入 caller-visible 结构
  }
  if (!row) return {};
  return {
    cwd: () => row.cwd,
    cwdReleaseMarker: () => row.cwdReleaseMarker,
  };
}

// mock impl: 接 deps + 模拟 impl 内部 warnings 数组
function mockRunArchivePlan(input, deps) {
  const implWarnings = [];
  if (deps.cwd) {
    implWarnings.push(`info: using caller cwd ${deps.cwd()}`);
  } else {
    implWarnings.push(`info: using DEFAULT_DEPS cwd (process.cwd=${process.cwd()})`);
  }
  return {
    archivedPath: '/fake/plan.md',
    commitHash: 'fakehash',
    warnings: implWarnings,
  };
}

// handler flow (复刻 archive-plan.ts handler 主路径)
function archivePlanHandler(input, mockSessionRepo) {
  const callerSessionId = input.callerSessionId || '__external__';
  const callerCwdDeps = resolveCallerCwdDeps(callerSessionId, mockSessionRepo);
  const result = mockRunArchivePlan(input, callerCwdDeps);
  // archive-plan.ts:215-222 ok return: 直接透传 result.warnings
  return {
    ...result,
    warnings: result.warnings,
  };
}

console.log('=== spike3: archive-plan fail-open warn 不 surface ok return.warnings ===\n');

// === case 1: SQLite locked (sessionRepo.get throw) ===
console.log('--- case 1: sessionRepo.get throw (SQLite locked simulation) ---');
const mockLockedRepo = {
  get(sid) {
    throw new Error('SQLITE_BUSY: database is locked');
  },
};
const result1 = archivePlanHandler({ callerSessionId: 'caller-1' }, mockLockedRepo);
console.log('ok return.warnings:', JSON.stringify(result1.warnings, null, 2));
const c1FailOpen = result1.warnings.some(
  (w) => w.includes('fail-open') || w.includes('threw') || w.includes('falling back'),
);
console.log(
  `contains fail-open warning in ok return.warnings: ${
    c1FailOpen ? '✅ YES (surfaced)' : '❌ NO (warning LOST — only on console.warn, not on caller-visible ok return.warnings)'
  }`,
);

// === case 2: sessionRepo.get returns null (caller session not found) ===
console.log('\n--- case 2: sessionRepo.get returns null (caller session not found) ---');
const mockNullRepo = {
  get(sid) {
    return null;
  },
};
const result2 = archivePlanHandler({ callerSessionId: 'caller-2' }, mockNullRepo);
console.log('ok return.warnings:', JSON.stringify(result2.warnings, null, 2));
const c2HasInfo = result2.warnings.some((w) => w.includes('DEFAULT_DEPS'));
console.log(
  `caller knows fell back to DEFAULT_DEPS: ${
    c2HasInfo ? '✅ YES (impl info hint)' : '❌ NO'
  } — but no explicit "session not found" warning either`,
);

// === case 3: sessionRepo.get OK (typical happy path) ===
console.log('\n--- case 3: sessionRepo.get OK (typical happy path) ---');
const mockOkRepo = {
  get(sid) {
    return { cwd: '/real/cwd', cwdReleaseMarker: '/wt/path' };
  },
};
const result3 = archivePlanHandler({ callerSessionId: 'caller-3' }, mockOkRepo);
console.log('ok return.warnings:', JSON.stringify(result3.warnings, null, 2));

// === summary ===
console.log('\n=== finding summary ===');
console.log('case 1 (SQLite locked): console.warn 输出 ✅ 但 ok return.warnings 不含 fail-open 警告 ❌');
console.log('  → operator 看 main process log 能 grep 到, caller (lead) 拿 ok return 看不到 fail-open 退化');
console.log('  → archive 走 DEFAULT_DEPS.cwd=process.cwd 仍成功(主仓库走 mainRepo git ops 不依赖 callerCwd)');
console.log('  → 但 caller 不知道有退化, 可能 silent 错合 (cwd precheck 降级)');
console.log('case 2 (session not found): 行为 silent 但 impl-side 隐式 info hint (DEFAULT_DEPS cwd)');
console.log('case 3 (OK path): typical');

console.log('\nspike3 done');
