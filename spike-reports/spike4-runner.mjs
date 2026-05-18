// Spike 4 runner: claude -p 内部 Bash / Read 工具在 codex sandbox 嵌套层下是否跑通
//
// 跑法:
//   /Users/apple/.nvm/versions/node/v24.10.0/bin/node \
//     /Users/apple/Repository/personal/agent-deck/.claude/worktrees/codex-handoff-team-alignment-20260518/spike-reports/spike4-runner.mjs
//
// 与 Spike 3 衔接:Spike 3 已实证 codex workspace-write 内 spawn `claude -p "say hi"` 完整跑通(spawn + 网络 + OAuth + jsonl 写)。
// Spike 4 进一步测**嵌套场景下 claude 自己内部 Bash/Read 工具能否跑通**(claude 在 codex sandbox-exec 内自己再起一层 sandbox-exec):
//   - Test 1: Bash 工具 → 让 claude 跑 `cat /tmp/hello.txt` 把 "say hi" 回报
//   - Test 2: Read 工具 → 让 claude 用 Read 工具读 /tmp/hello.txt
// 任一 PASS 都意味着 reviewer-claude wrapper(codex 视角)可以让 claude 真用工具读源码做 review。
//
// 关键 option(与 spike3 一致):
//   - sandbox=workspace-write(D3 决策的生产默认档)
//   - approvalPolicy='never'(无 UI 审批挂)
//   - networkAccessEnabled=true(claude 调 Anthropic API)
//   - additionalDirectories=['/Users/apple/.claude', '/Users/apple/.codex', '/tmp']
//     (claude 读 OAuth + 写 session jsonl + Test 1/2 的 /tmp 工作区)
//
// claude -p 关键 flag:
//   - --permission-mode bypassPermissions(让 claude 内部工具不弹审批 — oneshot 模式必需)

import { Codex } from 'file:///Users/apple/Repository/personal/agent-deck/node_modules/.pnpm/@openai+codex-sdk@0.120.0/node_modules/@openai/codex-sdk/dist/index.js';

const CLAUDE_BIN = '/Users/apple/.nvm/versions/node/v24.10.0/bin/claude';
const NODE_BIN_DIR = '/Users/apple/.nvm/versions/node/v24.10.0/bin';
const WORKTREE = '/Users/apple/Repository/personal/agent-deck/.claude/worktrees/codex-handoff-team-alignment-20260518';

const PROMPT = `这是 spike 沙箱嵌套探测自动化测试,开发者已授权,目的是看 claude CLI 在你的 sandbox 内自己起的 Bash/Read 工具能否跑通。请按下面 2 个 Test 精确执行,不要做替代尝试,不要分析"安全",不要建议解决方案。

每个 Test 都要在你的 shell 里执行下列命令格式(注意 PATH 前缀必填,不然 claude 找不到 node):

\`\`\`
PATH="${NODE_BIN_DIR}:$PATH" ${CLAUDE_BIN} -p --permission-mode bypassPermissions <CLAUDE_PROMPT> 2>&1; echo "EXIT=$?"
\`\`\`

把 <CLAUDE_PROMPT> 替换成下面对应内容(注意整体用单引号包裹,内部不要再用单引号):

**Test 1**(测 Bash 工具):
\`\`\`
'请用 Bash 工具运行 cat /tmp/hello.txt,把 cat 的完整输出原样报告给我;然后单独说一句"BASH_TOOL_OK"。'
\`\`\`

**Test 2**(测 Read 工具):
\`\`\`
'请用 Read 工具读 /tmp/hello.txt 文件,把读到的内容原样报告给我;然后单独说一句"READ_TOOL_OK"。'
\`\`\`

每个 Test 跑完把:
- 完整 stdout(claude 的回复)
- 退出码 EXIT=N
- 是否出现 "BASH_TOOL_OK" / "READ_TOOL_OK" 关键字
原样报告我。

最后总结:
- Test 1 PASS(出现 BASH_TOOL_OK + 输出含 "say hi") / FAIL(原因)
- Test 2 PASS(出现 READ_TOOL_OK + 输出含 "say hi") / FAIL(原因)

如果某个 Test 命令本身被你的环境拒绝(沙箱限制 / 审批拒绝 / 其他),把环境给你的错误原文完整报告我。`;

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

async function main() {
  divider('sandbox=workspace-write (production default per spike3)');
  const codex = new Codex();
  const thread = codex.startThread({
    sandboxMode: 'workspace-write',
    workingDirectory: WORKTREE,
    skipGitRepoCheck: true,
    modelReasoningEffort: 'low',
    webSearchEnabled: false,
    approvalPolicy: 'never',
    networkAccessEnabled: true,
    additionalDirectories: [
      '/Users/apple/.claude',
      '/Users/apple/.codex',
      '/tmp',
    ],
  });

  console.log('starting codex.run with 360s timeout...');
  const t0 = Date.now();
  try {
    const result = await runWithTimeout(thread.run(PROMPT), 360000, 'spike4');
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`elapsed=${elapsed}s`);
    divider('FINAL RESPONSE');
    console.log(result.finalResponse);
    divider('SUMMARY');
    const out = result.finalResponse ?? '';
    const test1Pass = /BASH_TOOL_OK/.test(out) && /say hi/.test(out);
    const test2Pass = /READ_TOOL_OK/.test(out) && /say hi/.test(out);
    console.log(JSON.stringify({
      elapsedSeconds: parseFloat(elapsed),
      test1_bash_pass: test1Pass,
      test2_read_pass: test2Pass,
      responseLen: out.length,
    }, null, 2));
    process.exit(0);
  } catch (e) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`threw after ${elapsed}s:`, e?.message);
    process.exit(1);
  }
}

main();
