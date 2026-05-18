// Spike 2 runner: codex SDK 子进程模型 + env snapshot 时机
//
// 直接 import 主 repo node_modules 内 codex-sdk(worktree 没 install)
// 用 file:// 绝对路径
//
// 跑法: node /Users/apple/Repository/personal/agent-deck/.claude/worktrees/codex-handoff-team-alignment-20260518/spike-reports/spike2-runner.mjs

import { Codex } from 'file:///Users/apple/Repository/personal/agent-deck/node_modules/.pnpm/@openai+codex-sdk@0.120.0/node_modules/@openai/codex-sdk/dist/index.js';

const baseOpts = {
  sandboxMode: 'workspace-write',
  workingDirectory: '/tmp',
  skipGitRepoCheck: true,
  modelReasoningEffort: 'low',
  webSearchEnabled: false,
};

const PROMPT_ECHO_TOKEN =
  '请在你的 shell 里运行命令 `echo "SPIKE_LABEL=$SPIKE_LABEL"`,然后把命令输出原样回复给我。不要做其他事情。这是一个 spike 自动化测试,变量值是非敏感标签字符串,不是密钥。';
const PROMPT_ECHO_PID =
  '请在你的 shell 里运行命令 `echo "MY_SHELL_PID=$$"`,然后把命令输出原样回复给我。不要做其他事情。';

function divider(label) {
  console.log(`\n========== ${label} ==========\n`);
}

async function runWithTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// TEST 1: envOverride frozen
// ============================================================
async function test1_envOverrideFrozen() {
  divider('TEST 1: envOverride frozen');

  // 两个 Codex 实例,各自显式 env(snapshot 时刻 process.env 一致但 SPIKE_LABEL 不同)
  const codex1 = new Codex({ env: { ...process.env, SPIKE_LABEL: 'tagA' } });
  const codex2 = new Codex({ env: { ...process.env, SPIKE_LABEL: 'tagB' } });

  // 在两个 Codex 都 new 完之后再改 process.env,看会不会污染已创建的 envOverride
  process.env.SPIKE_LABEL = 'tagINTERFERER';

  const t1 = codex1.startThread(baseOpts);
  const t2 = codex2.startThread(baseOpts);

  console.log('[T1] 并发起 t1(envOverride=tagA) 与 t2(envOverride=tagB)...');
  console.log('[T1] process.env.SPIKE_LABEL =', process.env.SPIKE_LABEL);

  const [r1, r2] = await Promise.all([
    runWithTimeout(t1.run(PROMPT_ECHO_TOKEN), 180000, 't1'),
    runWithTimeout(t2.run(PROMPT_ECHO_TOKEN), 180000, 't2'),
  ]);

  console.log('[T1] codex1.finalResponse:', JSON.stringify(r1.finalResponse));
  console.log('[T1] codex2.finalResponse:', JSON.stringify(r2.finalResponse));

  // 断言期望:codex1 看到 tagA,codex2 看到 tagB
  const okT1c1 = r1.finalResponse.includes('SPIKE_LABEL=tagA');
  const okT1c2 = r2.finalResponse.includes('SPIKE_LABEL=tagB');
  console.log(
    '[T1] 断言:codex1=tagA →',
    okT1c1 ? 'PASS' : 'FAIL',
    '|',
    'codex2=tagB →',
    okT1c2 ? 'PASS' : 'FAIL',
  );

  return { test: 'envOverride frozen', codex1: r1.finalResponse, codex2: r2.finalResponse, pass: okT1c1 && okT1c2 };
}

// ============================================================
// TEST 2: process.env fallback (no envOverride)
//
// 验证「runStreamed 真正 spawn 子进程的时机」+「process.env fallback 行为」
// ============================================================
async function test2_processEnvFallback() {
  divider('TEST 2: process.env fallback');

  process.env.SPIKE_LABEL = 'tagC';
  const codex3 = new Codex(); // 不传 env → 走 process.env fallback

  const t3 = codex3.startThread(baseOpts);
  console.log('[T2] startThread 已返回(同步) 此时 process.env.SPIKE_LABEL = tagC');

  // 在 t3.run() 调用之前 mutate process.env
  // 因为 startThread 没 spawn 子进程(它只创建 Thread 对象)
  // 真正 spawn 子进程的时机是 t3.run() 内部 iterate generator 时
  process.env.SPIKE_LABEL = 'tagD';
  console.log('[T2] mutate 后 process.env.SPIKE_LABEL = tagD');

  // 现在 run — 期望子进程拿到 tagD(因为 spawn 在 run() 内)
  const r3 = await runWithTimeout(t3.run(PROMPT_ECHO_TOKEN), 180000, 't3');
  console.log('[T2] codex3.finalResponse:', JSON.stringify(r3.finalResponse));

  const okT2 = r3.finalResponse.includes('SPIKE_LABEL=tagD');
  console.log('[T2] 断言:codex3=tagD →', okT2 ? 'PASS' : 'FAIL');

  return {
    test: 'process.env fallback',
    expected: 'tagD',
    actual: r3.finalResponse,
    pass: okT2,
  };
}

// ============================================================
// TEST 3: subprocess PID independence
// ============================================================
async function test3_subprocessPidIndependent() {
  divider('TEST 3: subprocess PID independence');

  const codex4 = new Codex();
  const codex5 = new Codex();

  const t4 = codex4.startThread(baseOpts);
  const t5 = codex5.startThread(baseOpts);

  console.log('[T3] 并发起 t4 + t5,各让 codex 执行 echo $$ 拿子进程 PID...');

  const [r4, r5] = await Promise.all([
    runWithTimeout(t4.run(PROMPT_ECHO_PID), 180000, 't4'),
    runWithTimeout(t5.run(PROMPT_ECHO_PID), 180000, 't5'),
  ]);

  console.log('[T3] codex4.finalResponse:', JSON.stringify(r4.finalResponse));
  console.log('[T3] codex5.finalResponse:', JSON.stringify(r5.finalResponse));

  // 提取 PID
  const pid4 = (r4.finalResponse.match(/MY_SHELL_PID=(\d+)/) || [])[1];
  const pid5 = (r5.finalResponse.match(/MY_SHELL_PID=(\d+)/) || [])[1];

  console.log('[T3] pid4 =', pid4, '| pid5 =', pid5);
  const okT3 = pid4 && pid5 && pid4 !== pid5;
  console.log(
    '[T3] 断言:两个 codex 子进程 PID 各异 →',
    okT3 ? 'PASS' : 'FAIL',
  );

  return {
    test: 'subprocess pid independent',
    pid4,
    pid5,
    pass: okT3,
  };
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  const results = [];
  try {
    results.push(await test1_envOverrideFrozen());
  } catch (e) {
    console.error('[T1] threw:', e?.message);
    results.push({ test: 'envOverride frozen', error: e?.message, pass: false });
  }

  try {
    results.push(await test2_processEnvFallback());
  } catch (e) {
    console.error('[T2] threw:', e?.message);
    results.push({ test: 'process.env fallback', error: e?.message, pass: false });
  }

  try {
    results.push(await test3_subprocessPidIndependent());
  } catch (e) {
    console.error('[T3] threw:', e?.message);
    results.push({ test: 'subprocess pid independent', error: e?.message, pass: false });
  }

  divider('SUMMARY');
  for (const r of results) {
    console.log(JSON.stringify(r));
  }

  const failCount = results.filter((r) => !r.pass).length;
  console.log(`\nPassed ${results.length - failCount}/${results.length}`);
  process.exit(failCount === 0 ? 0 : 1);
}

main();
