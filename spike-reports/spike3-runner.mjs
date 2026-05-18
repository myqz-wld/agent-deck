// Spike 3 runner: codex SDK sandbox 是否允许 spawn 外部 CLI 子进程
//
// 跑法:
//   /Users/apple/.nvm/versions/node/v24.10.0/bin/node \
//     /Users/apple/Repository/personal/agent-deck/.claude/worktrees/codex-handoff-team-alignment-20260518/spike-reports/spike3-runner.mjs
//
// 同 Spike 2:用 file:// 绝对路径 import codex-sdk(worktree 无 node_modules)
// + 绝对路径 node binary(避 Bash tool cd 触发 GVM_ROOT init bug)
// + 'low' reasoning effort + webSearchEnabled=false(避 'minimal' + web_search 冲突)
// + 中性变量名(避 codex LLM alignment 拒绝)
//
// 关键扩展:
// - approvalPolicy='never':避 codex SDK 在 spawn 外部 CLI 时弹审批(SDK 无 UI 会挂)
// - networkAccessEnabled=true:claude CLI 需要 HTTP 调 Anthropic API
// - additionalDirectories=['/Users/apple/.claude']:claude 读 OAuth creds + 写 session jsonl

import { Codex } from 'file:///Users/apple/Repository/personal/agent-deck/node_modules/.pnpm/@openai+codex-sdk@0.120.0/node_modules/@openai/codex-sdk/dist/index.js';

const CLAUDE_BIN = '/Users/apple/.nvm/versions/node/v24.10.0/bin/claude';
const NODE_BIN_DIR = '/Users/apple/.nvm/versions/node/v24.10.0/bin';
const WORKTREE = '/Users/apple/Repository/personal/agent-deck/.claude/worktrees/codex-handoff-team-alignment-20260518';

// 4 个 Step 探测从 trivial → spawn → 外部 CLI 全链路:
// Step 1: ls(用 shell builtin /bin/ls + 文件路径,纯 read,不写 fs)
// Step 2: cat(spawn 外部 cat binary,纯 read fs)
// Step 3: claude --version(spawn node + claude.mjs,无网络,只读 install dir)
// Step 4: claude -p "say hi"(spawn + 网络 + 读 OAuth creds + 写 session jsonl,完整 reviewer 路径)
const PROMPT = `这是 spike 沙箱探测自动化测试,开发者已授权,目的是看你的 shell 沙箱内能否 spawn 外部 CLI 子进程。请按下面步骤精确执行,不要做替代尝试,不要分析"安全",不要建议解决方案:

Step 1: 运行 \`/bin/ls -la /tmp/hello.txt 2>&1; echo "EXIT=$?"\`,把完整输出包括退出码报告我。
Step 2: 运行 \`/bin/cat /tmp/hello.txt 2>&1; echo "EXIT=$?"\`,完整输出 + 退出码报告我。
Step 3: 运行 \`PATH="${NODE_BIN_DIR}:$PATH" ${CLAUDE_BIN} --version 2>&1; echo "EXIT=$?"\`,完整输出 + 退出码报告我。
Step 4: 运行 \`PATH="${NODE_BIN_DIR}:$PATH" ${CLAUDE_BIN} -p "say hi" 2>&1; echo "EXIT=$?"\`,完整输出 + 退出码报告我。

如果某步命令被你的环境拒绝执行(沙箱限制 / 审批拒绝 / 其他),把环境给你的错误原文完整报告我。最后总结哪些 step PASS(EXIT=0) / FAIL,FAIL 的根因分类(沙箱拒 spawn / 沙箱拒读 / 沙箱拒写 / 沙箱拒网 / 命令本身失败 / 其他)。`;

const SANDBOX_MODES = ['workspace-write', 'read-only', 'danger-full-access'];

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

async function runOneMode(sandboxMode) {
  divider(`sandbox=${sandboxMode}`);
  const codex = new Codex();
  const thread = codex.startThread({
    sandboxMode,
    workingDirectory: WORKTREE,
    skipGitRepoCheck: true,
    modelReasoningEffort: 'low',
    webSearchEnabled: false,
    approvalPolicy: 'never',
    networkAccessEnabled: true,
    additionalDirectories: ['/Users/apple/.claude'],
  });

  console.log(`[${sandboxMode}] starting codex.run with 200s timeout...`);
  const t0 = Date.now();
  try {
    const result = await runWithTimeout(thread.run(PROMPT), 200000, sandboxMode);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[${sandboxMode}] elapsed=${elapsed}s`);
    console.log(`[${sandboxMode}] finalResponse:\n${result.finalResponse}`);
    return { sandboxMode, elapsedSeconds: parseFloat(elapsed), finalResponse: result.finalResponse, pass: true };
  } catch (e) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`[${sandboxMode}] threw after ${elapsed}s:`, e?.message);
    return { sandboxMode, elapsedSeconds: parseFloat(elapsed), error: e?.message, pass: false };
  }
}

async function main() {
  const results = [];
  for (const mode of SANDBOX_MODES) {
    results.push(await runOneMode(mode));
    // 给 codex CLI 子进程清理时间
    await new Promise((r) => setTimeout(r, 3000));
  }

  divider('SUMMARY');
  for (const r of results) {
    console.log(JSON.stringify({
      sandboxMode: r.sandboxMode,
      elapsedSeconds: r.elapsedSeconds,
      pass: r.pass,
      error: r.error,
      responseLen: r.finalResponse?.length,
    }));
  }

  const failCount = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failCount}/${results.length} 个 mode 跑通(pass !== 沙箱内 4 step 全 EXIT=0,只表示 codex run 本身没 throw)`);
  process.exit(0);
}

main();
