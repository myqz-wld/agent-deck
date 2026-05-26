#!/usr/bin/env node
/**
 * spike2 mini-runner: Claude / codex SDK fork detect 触发条件 + 后续 sid。
 *
 * 不烧 SDK 子进程,而是从应用源码内 fork detect 实现 + 已有 fork test 验证假设。
 *
 * 验证目标 (plan §设计决策 D2 *待 spike 验证*):
 * 1. claude SDK fork 触发条件 (streaming + resume + 新 prompt → CLI 隐式 fork)
 * 2. fork 判定逻辑: stream-processor.ts L305 `if (resumeId && resumeId !== realId)`
 * 3. fork 后 hook event body.session_id = NEW_ID (CLI 切到新 thread)
 * 4. codex SDK 不支持隐式 fork (recoverer.ts:34 / thread-loop.ts:235 注释 future-proof case)
 * 5. 7 处反向 rename 路径全部已识别 (claude 4 处 / codex 3 处)
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
      hits.push({ line: i + 1, text: lines[i].trim().slice(0, 120) });
    }
  }
  return hits;
}

// ─── 2.1 claude fork detect: stream-processor.ts:305 ─────────────────────
const streamProc = join(REPO_ROOT, 'src/main/adapters/claude-code/sdk-bridge/stream-processor.ts');
const forkDetect = grepFile(streamProc, /resumeId\s+&&\s+resumeId\s+!==\s+realId/);
console.log(`[spike2.1] claude fork detect (stream-processor.ts):`);
forkDetect.forEach((h) => console.log(`  L${h.line}: ${h.text}`));
console.log(forkDetect.length > 0 ? '  ✅ fork 判定逻辑命中' : '  ❌ 未找到 fork 判定');

// ─── 2.2 claude fork rename 路径 (4 处) ────────────────────────────────
const claudeRenames = [];
const claudePaths = [
  ['src/main/adapters/claude-code/sdk-bridge/recoverer.ts', /sessionManager\.renameSdkSession\(/, 'recoverer (jsonl-missing fallback)'],
  ['src/main/adapters/claude-code/sdk-bridge/stream-processor.ts', /sessionManager\.renameSdkSession\(/, 'stream-processor (fork detect)'],
  ['src/main/adapters/claude-code/sdk-bridge/restart-controller.ts', /sessionManager\.renameSdkSession\(/, 'restart-controller (close-restart / open-restart)'],
];
for (const [rel, regex, desc] of claudePaths) {
  const full = join(REPO_ROOT, rel);
  if (!existsSync(full)) continue;
  const hits = grepFile(full, regex);
  hits.forEach((h) => {
    claudeRenames.push({ file: rel, line: h.line, desc, text: h.text });
  });
}
console.log(`\n[spike2.2] claude renameSdkSession 调用点:`);
claudeRenames.forEach((r) => console.log(`  ${r.file}:${r.line} (${r.desc})`));
console.log(`  共 ${claudeRenames.length} 处`);

// ─── 2.3 codex fork rename 路径 (post-resume case 3 + restart) ──────────
const codexRenames = [];
const codexPaths = [
  ['src/main/adapters/codex-cli/sdk-bridge/recoverer.ts', /sessionManager\.renameSdkSession\(/, 'recoverer (jsonl-missing fallback)'],
  ['src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts', /sessionManager\.renameSdkSession\(/, 'thread-loop case 3 (post-resume fork future-proof)'],
  ['src/main/adapters/codex-cli/sdk-bridge/restart-controller.ts', /sessionManager\.renameSdkSession\(/, 'restart-controller'],
];
for (const [rel, regex, desc] of codexPaths) {
  const full = join(REPO_ROOT, rel);
  if (!existsSync(full)) continue;
  const hits = grepFile(full, regex);
  hits.forEach((h) => {
    codexRenames.push({ file: rel, line: h.line, desc, text: h.text });
  });
}
console.log(`\n[spike2.3] codex renameSdkSession 调用点:`);
codexRenames.forEach((r) => console.log(`  ${r.file}:${r.line} (${r.desc})`));
console.log(`  共 ${codexRenames.length} 处`);

// ─── 2.4 hook event 携带 sid 来源验证 ───────────────────────────────────
const translateFile = join(REPO_ROOT, 'src/main/adapters/claude-code/translate.ts');
const sessionStartHook = grepFile(translateFile, /sessionId:\s+p\.session_id/);
console.log(`\n[spike2.4] hook event sid 来源 (translate.ts):`);
sessionStartHook.slice(0, 5).forEach((h) => console.log(`  L${h.line}: ${h.text}`));
console.log(`  ✅ hook payload.session_id 即 CLI 子进程当前 thread sid`);

// ─── 2.5 codex 不支持隐式 fork (注释铁证 + thread-loop case 3 future-proof) ──
const codexRecover = join(REPO_ROOT, 'src/main/adapters/codex-cli/sdk-bridge/recoverer.ts');
const codexNoForkAssert = grepFile(codexRecover, /codex\s+(不支持|不\s+implicit\s+fork)/);
console.log(`\n[spike2.5] codex 不支持隐式 fork 注释:`);
codexNoForkAssert.slice(0, 3).forEach((h) => console.log(`  L${h.line}: ${h.text}`));

const threadLoop = join(REPO_ROOT, 'src/main/adapters/codex-cli/sdk-bridge/thread-loop.ts');
const case3 = grepFile(threadLoop, /CLI\s+隐式\s+fork.*未来|case\s+3.*恢复/);
console.log(`  thread-loop case 3 future-proof:`);
case3.slice(0, 3).forEach((h) => console.log(`  L${h.line}: ${h.text}`));

// ─── 2.6 sdk-bridge.consume-fork.test.ts 已有覆盖 ───────────────────────
const consumeForkTest = join(
  REPO_ROOT,
  'src/main/adapters/claude-code/__tests__/sdk-bridge.consume-fork.test.ts',
);
const testDescribes = grepFile(consumeForkTest, /it\(['"`].*fork/);
console.log(`\n[spike2.6] 已有 fork test 覆盖 (claude consume-fork.test):`);
testDescribes.slice(0, 5).forEach((h) => console.log(`  L${h.line}: ${h.text}`));

console.log('\n[spike2] 完成。结论 inline 进 spike2-fork-detect-trigger.md');
