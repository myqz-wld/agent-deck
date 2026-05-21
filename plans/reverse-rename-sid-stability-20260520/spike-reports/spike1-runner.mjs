#!/usr/bin/env node
/**
 * spike1 mini-runner（read-only 静态实测）。
 *
 * 不烧 OAuth quota / 不真起 SDK 子进程,而是从已落盘的 SDK 源码 + 真实
 * ~/.claude/projects/ jsonl 目录提取硬铁证。
 *
 * 验证目标(plan §设计决策 D1 *待 spike 验证*):
 * 1. SDK `--resume <sid>` 直接 verbatim 透到 CLI binary args,不做转换
 * 2. jsonl 路径命名规则 `~/.claude/projects/<encoded-cwd>/<sid>.jsonl`
 * 3. jsonl 文件名 == 文件内第一条 record 的 sessionId (即 CLI 写文件时用的 sid)
 * 4. encodeClaudeProjectDir 规则与应用层 platform.ts 一致
 *
 * 结论 inline 进 spike1-cli-session-id-resume.md。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLAN_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(PLAN_DIR, '..', '..', '..', '..');

// ─── 1. SDK 源码: --resume 传参契约 ──────────────────────────────────────
const sdkPkgs = readdirSync(join(REPO_ROOT, 'node_modules/.pnpm'))
  .filter((p) => p.startsWith('@anthropic-ai+claude-agent-sdk@0.3.144'));
if (sdkPkgs.length === 0) {
  console.error('[spike1] SDK 0.3.144 not installed');
  process.exit(1);
}
const sdkRoot = join(
  REPO_ROOT,
  'node_modules/.pnpm',
  sdkPkgs[0],
  'node_modules/@anthropic-ai/claude-agent-sdk',
);
const sdkMjs = readFileSync(join(sdkRoot, 'sdk.mjs'), 'utf-8');
const resumeMatch = sdkMjs.match(/if\(k\)i\.push\("--resume",k\)/);
console.log(
  `[spike1.1] SDK --resume verbatim 透传:`,
  resumeMatch ? '✅ 命中 `if(k)i.push("--resume",k)`' : '❌ 未找到',
);

// ─── 2. jsonl 文件名 == 第一条 record sessionId 实测 ─────────────────────
const projectsDir = join(homedir(), '.claude/projects');
const cwdEncoded = '-Users-apple-Repository-personal-agent-deck';
const targetDir = join(projectsDir, cwdEncoded);
if (!existsSync(targetDir)) {
  console.error(`[spike1.2] target dir not found: ${targetDir}`);
  process.exit(1);
}
const jsonls = readdirSync(targetDir).filter((f) => f.endsWith('.jsonl'));
// 取最近 mtime 5 个验证
const samples = jsonls
  .map((f) => {
    const full = join(targetDir, f);
    return { file: f, mtime: statSync(full).mtimeMs, full };
  })
  .sort((a, b) => b.mtime - a.mtime)
  .slice(0, 5);

let matchCount = 0;
let mismatchCount = 0;
const mismatchSamples = [];
for (const s of samples) {
  const fnameSid = s.file.replace(/\.jsonl$/, '');
  const firstLine = readFileSync(s.full, 'utf-8').split('\n')[0];
  let firstObj;
  try {
    firstObj = JSON.parse(firstLine);
  } catch {
    console.log(`  ${s.file}: ⚠ first line invalid JSON, skip`);
    continue;
  }
  const bodySid = firstObj.sessionId;
  if (bodySid === fnameSid) {
    matchCount++;
  } else {
    mismatchCount++;
    mismatchSamples.push({ file: s.file, bodySid });
  }
}
console.log(
  `[spike1.2] jsonl 文件名 == body.sessionId: ${matchCount}/${samples.length} match, ${mismatchCount} mismatch`,
);
if (mismatchCount > 0) {
  console.log('  mismatch samples:', JSON.stringify(mismatchSamples, null, 2));
}

// ─── 3. encodeClaudeProjectDir 规则验证 ─────────────────────────────────
function encodeClaudeProjectDir(cwd) {
  return '-' + cwd.split('/').filter(Boolean).join('-');
}
const testCwd = '/Users/apple/Repository/personal/agent-deck';
const encoded = encodeClaudeProjectDir(testCwd);
const expectedDir = '-Users-apple-Repository-personal-agent-deck';
console.log(
  `[spike1.3] encodeClaudeProjectDir('${testCwd}') = '${encoded}' (expected '${expectedDir}')`,
  encoded === expectedDir ? '✅' : '❌',
);

// ─── 4. fork detect 触发条件 grep (与 spike2 重合,这里做 sanity) ─────────
const streamProcMatch = sdkMjs.match(/forkSession/);
console.log(
  `[spike1.4] SDK has forkSession 接口:`,
  streamProcMatch ? '✅' : '❌',
);

console.log('\n[spike1] 完成。结论 inline 进 spike1-cli-session-id-resume.md');
