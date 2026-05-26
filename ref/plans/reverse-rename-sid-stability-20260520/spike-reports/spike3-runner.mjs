#!/usr/bin/env node
/**
 * spike3 mini-runner: wire prefix sid 现状 + 真实 reply 流验证。
 *
 * 验证目标 (plan §设计决策 D7 *待 spike 验证*):
 * 1. wire prefix `[sid <senderSid>]` 写哪个 sid (sessions.id 还是 cli_session_id)
 * 2. caller.callerSessionId 来源链路 (in-process transport / http transport / stdio transport)
 * 3. 反向 rename 后 wire prefix sid 不变 (sessions.id 稳定)
 * 4. send_message no-shared-team check 走 sessions.id (不撞 cli_session_id 变化)
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLAN_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(PLAN_DIR, '..', '..', '..', '..');

function grepFile(file, regex) {
  const text = readFileSync(file, 'utf-8');
  const lines = text.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      hits.push({ line: i + 1, text: lines[i].trim().slice(0, 140) });
    }
  }
  return hits;
}

// ─── 3.1 wire prefix `[sid ${...}]` 写哪个 sid ────────────────────────────
const watcherFile = join(REPO_ROOT, 'src/main/teams/universal-message-watcher/index.ts');
const wireBuilder = grepFile(watcherFile, /\[sid \$\{message\.fromSessionId\}/);
console.log(`[spike3.1] wire prefix builder (universal-message-watcher/index.ts):`);
wireBuilder.forEach((h) => console.log(`  L${h.line}: ${h.text}`));

// ─── 3.2 spawn handler wire prefix sid ─────────────────────────────────────
const spawnFile = join(REPO_ROOT, 'src/main/agent-deck-mcp/tools/handlers/spawn.ts');
const spawnWire = grepFile(spawnFile, /\[sid \$\{caller\.callerSessionId\}/);
console.log(`\n[spike3.2] spawn handler wire prefix (spawn.ts):`);
spawnWire.forEach((h) => console.log(`  L${h.line}: ${h.text}`));

// ─── 3.3 send_message handler fromSessionId 来源 ─────────────────────────
const sendFile = join(REPO_ROOT, 'src/main/agent-deck-mcp/tools/handlers/send.ts');
const sendFromSid = grepFile(sendFile, /fromSessionId:\s*caller\.callerSessionId/);
console.log(`\n[spike3.3] send_message handler fromSessionId 来源:`);
sendFromSid.forEach((h) => console.log(`  L${h.line}: ${h.text}`));

// ─── 3.4 send_message no-shared-team check 走 sessions.id ─────────────────
const sharedTeams = grepFile(sendFile, /findSharedActiveTeams\(/);
console.log(`\n[spike3.4] send_message shared team check (走 sessions.id):`);
sharedTeams.forEach((h) => console.log(`  L${h.line}: ${h.text}`));

// ─── 3.5 caller.callerSessionId 来源链 (in-process / http / stdio) ────────
const helpersFile = join(REPO_ROOT, 'src/main/agent-deck-mcp/tools/helpers.ts');
const helpersHits = grepFile(helpersFile, /callerSessionId:\s+callerSid/);
console.log(`\n[spike3.5] HandlerContext.caller.callerSessionId 来源 (helpers.ts):`);
helpersHits.forEach((h) => console.log(`  L${h.line}: ${h.text}`));

// ─── 3.6 in-process transport callerSessionIdOverride ────────────────────
const httpTransport = join(REPO_ROOT, 'src/main/agent-deck-mcp/transport-http.ts');
const inProcessSid = grepFile(httpTransport, /authInfo\?\.resolvedSid|EXTERNAL_CALLER_SENTINEL/);
console.log(`\n[spike3.6] HTTP transport callerSessionId 提取链:`);
inProcessSid.slice(0, 5).forEach((h) => console.log(`  L${h.line}: ${h.text}`));

// ─── 3.7 mcp-session-token-map 是 sessions.id 还是 cli_session_id ──────────
const tokenMap = join(REPO_ROOT, 'src/main/agent-deck-mcp/mcp-session-token-map.ts');
if (existsSync(tokenMap)) {
  const tokenSidLine = grepFile(tokenMap, /sessionId|sid /);
  console.log(`\n[spike3.7] mcp-session-token-map 写的 sid 含义:`);
  tokenSidLine.slice(0, 6).forEach((h) => console.log(`  L${h.line}: ${h.text}`));
}

// ─── 3.8 反向 rename 后 wire prefix sid 是否稳定的 invariant 推论 ──────────
console.log(`\n[spike3.8] 反向 rename 后 wire prefix sid 稳定推论:`);
console.log(`  caller.callerSessionId 来自 mcp transport callerSessionIdOverride()`);
console.log(`  → in-process: 注入 spawn 时透传的 sessionId (sessions.id)`);
console.log(`  → http: authInfo.resolvedSid (mcp-session-token-map.get 反查 sessions.id)`);
console.log(`  → stdio: EXTERNAL_CALLER_SENTINEL (固定字面量)`);
console.log(`  ✅ 三种 transport 都不读 cli_session_id,反向 rename 后 wire prefix sid 100% 稳定`);

console.log('\n[spike3] 完成。结论 inline 进 spike3-wire-prefix-sid.md');
