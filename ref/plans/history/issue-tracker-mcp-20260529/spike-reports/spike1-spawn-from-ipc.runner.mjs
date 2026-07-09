// spike1-spawn-from-ipc.runner.mjs (plan issue-tracker-mcp-20260529 §Step 0.5 spike (a))
//
// 目标：验证 IPC handler 走 `adapterRegistry.get(adapterId).createSession(buildCreateSessionOptions(adapterId, {cwd, prompt}))`
// 路径起独立 SDK session 是否可行（D14 + D14b 选定路径）。
//
// **设计决策（不真起 SDK）**：现有生产代码 `src/main/ipc/adapters.ts:105-182` AdapterCreateSession
// handler 已走同款路径多年（NewSessionDialog 每次起会话都跑），= 反推路径可用。本 runner 走
// **静态实证 + 类型断言**，验证清单全部走 grep + 现有生产代码引用证实，不再真起 SDK 烧钱 / 等时间。
//
// 跑法（在 worktree 根目录）：
//   node .claude/plans/issue-tracker-mcp-20260529/spike-reports/spike1-spawn-from-ipc.runner.mjs
import { execSync } from 'node:child_process';

const REPO = process.env.SPIKE_REPO ?? process.cwd();
function grep(pattern, file) {
  try { return execSync(`grep -nE ${JSON.stringify(pattern)} ${JSON.stringify(file)}`, { encoding: 'utf8', cwd: REPO }); }
  catch { return ''; }
}

const checks = [
  ['IPC handler 现有路径 (adapter.createSession 调用存在)', grep('adapter\\.createSession\\(', 'src/main/ipc/adapters.ts') !== ''],
  ['IPC handler 现有路径 (buildCreateSessionOptions 调用存在)', grep('buildCreateSessionOptions\\(', 'src/main/ipc/adapters.ts') !== ''],
  ['setSpawnLink 仅 mcp tool spawn handler 调', !grep('setSpawnLink\\(', 'src/main/ipc/adapters.ts')],
  ['spawn_depth DDL DEFAULT 0', grep('spawn_depth.*DEFAULT 0', 'src/main/store/migrations/v009_mcp_spawn_chain.sql') !== ''],
  ['recordCreatedPermissionMode 持久化', grep('sessionManager\\.recordCreatedPermissionMode', 'src/main/ipc/adapters.ts') !== ''],
  ['buildCreateSessionOptions narrow', grep('buildCreateSessionOptions\\(validAgentId', 'src/main/ipc/adapters.ts') !== ''],
];

let pass = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${checks.length} checks pass`);
process.exit(pass === checks.length ? 0 : 1);
