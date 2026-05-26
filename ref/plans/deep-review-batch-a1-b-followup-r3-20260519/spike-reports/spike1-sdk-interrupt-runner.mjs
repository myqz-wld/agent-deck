#!/usr/bin/env node
/**
 * spike1: SDK query.interrupt() 边界行为实测
 *
 * 改进版 (前一版 stdout 0byte hang 住):
 * - process.stdout.write 替代 console.log (强制 unbuffered)
 * - settingSources: ['user'] (让 SDK 子进程能读 ~/.claude OAuth credentials)
 * - cwd = main repo (而非 /tmp,避免 settings 读取异常)
 * - 90s 总超时兜底 (process.exit(2))
 *
 * Usage:
 *   pnpm exec node spike1-sdk-interrupt-runner.mjs A    # interrupt before first id
 *   pnpm exec node spike1-sdk-interrupt-runner.mjs B    # interrupt right after first id
 *   pnpm exec node spike1-sdk-interrupt-runner.mjs ping # baseline 不 interrupt 看流自然完成
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

const startedAt = Date.now();
function log(label, extra = '') {
  const t = String(Date.now() - startedAt).padStart(6, ' ');
  process.stdout.write(`[t=${t}ms] ${label}${extra ? ' ' + extra : ''}\n`);
}

const caseId = process.argv[2] ?? 'A';
log(`SPIKE START`, `case=${caseId}`);

// 90s 兜底 timeout
const hardTimeout = setTimeout(() => {
  log(`HARD TIMEOUT @ 90s`, '— exit 2');
  process.exit(2);
}, 90_000);

let nextResolver = null;
async function* userMessages() {
  yield {
    type: 'user',
    message: { role: 'user', content: "reply with the single word 'ok' and nothing else" },
    parent_tool_use_id: null,
    session_id: '',
  };
  await new Promise((r) => {
    nextResolver = r;
  });
}

let q;
try {
  q = query({
    prompt: userMessages(),
    options: {
      cwd: '/Users/apple/Repository/personal/agent-deck',
      // ['user'] 让 SDK 子进程从 ~/.claude/ 读 OAuth + 默认 settings
      settingSources: ['user'],
      // 关掉所有 model 工具,简化 frame 流
      canUseTool: async () => ({ behavior: 'deny', message: 'no tools', interrupt: false }),
    },
  });
  log(`query() returned`, `q type=${typeof q}`);
} catch (err) {
  log(`query() THREW`, `err=${err?.message}`);
  process.exit(3);
}

async function callInterrupt(label) {
  log(`-> interrupt() called`, `(${label})`);
  try {
    await q.interrupt();
    log(`<- interrupt() RESOLVED`, `(${label})`);
  } catch (err) {
    log(
      `<- interrupt() REJECTED`,
      `(${label}) error.name=${err?.constructor?.name} msg=${err?.message}`,
    );
  }
}

if (caseId === 'A') {
  setTimeout(() => callInterrupt('A: ~50ms before first id expected'), 50);
}

let frameCount = 0;
let firstSessionId = null;
let interruptedAfterFirstId = false;

try {
  for await (const msg of q) {
    frameCount++;
    const sid = msg?.session_id ?? null;
    const type = msg?.type;
    const subtype = msg?.subtype ?? '';
    log(
      `frame #${frameCount}`,
      `type=${type}${subtype ? ` subtype=${subtype}` : ''}${sid ? ` sid=${String(sid).slice(0, 8)}` : ''}`,
    );

    if (!firstSessionId && sid) {
      firstSessionId = sid;
      log(`==> first session_id seen`, `sid=${String(sid).slice(0, 8)}`);

      if (caseId === 'B' && !interruptedAfterFirstId) {
        interruptedAfterFirstId = true;
        callInterrupt('B: immediately after first id').catch(() => {});
      }
    }
  }
  log(`STREAM ENDED naturally`, `total=${frameCount} firstSid=${firstSessionId ? String(firstSessionId).slice(0, 8) : 'NEVER'}`);
} catch (err) {
  log(
    `STREAM THREW`,
    `err.name=${err?.constructor?.name} msg=${err?.message} total=${frameCount} firstSid=${firstSessionId ? String(firstSessionId).slice(0, 8) : 'NEVER'}`,
  );
}

clearTimeout(hardTimeout);
log(`SPIKE END`, `case=${caseId}`);
if (nextResolver) nextResolver();
process.exit(0);
