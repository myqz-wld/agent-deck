#!/usr/bin/env node
/**
 * spike4 mini-runner: 迟到 hook event sid + sessionRepo.findByCliSessionId 反查。
 *
 * 验证目标 (plan §设计决策 D7 *待 spike 验证*):
 * 1. 当前 recentlyDeleted 黑名单实现 (sessionId 字符串 key + 60s TTL)
 * 2. 反向 rename 后黑名单 key 含义改为 OLD_CLI_ID (而非 sessions.id)
 * 3. ingest 入口 isRecentlyDeleted 早返时序 (manager.ts:224)
 * 4. 新增 sessionRepo.findByCliSessionId(cliSid) — schema 设计:加唯一索引避 O(N)
 * 5. 反向 rename 后 ingest pipeline 流程: findByCliSessionId 反查 → application sid → 正常路径
 *
 * 不真起 SDK 子进程,只验证现有代码结构允许 D7 修法落地。
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

// ─── 4.1 当前 recentlyDeleted Map<string, number> 实现 ────────────────────
const managerFile = join(REPO_ROOT, 'src/main/session/manager.ts');
const blacklistDecl = grepFile(managerFile, /private\s+recentlyDeleted\s*=/);
console.log(`[spike4.1] recentlyDeleted Map 声明 (manager.ts):`);
blacklistDecl.forEach((h) => console.log(`  L${h.line}: ${h.text}`));

const setCalls = grepFile(managerFile, /this\.recentlyDeleted\.set/);
console.log(`\n[spike4.1] recentlyDeleted.set 调用点 (3 个):`);
setCalls.forEach((h) => console.log(`  L${h.line}: ${h.text}`));

// ─── 4.2 ingest 入口 isRecentlyDeleted 早返 (manager.ts:224) ─────────────
const earlyReturn = grepFile(managerFile, /isRecentlyDeleted\(event\.sessionId\)/);
console.log(`\n[spike4.2] ingest 入口 isRecentlyDeleted 早返:`);
earlyReturn.forEach((h) => console.log(`  L${h.line}: ${h.text}`));

// ─── 4.3 当前 sessionRepo 函数列表 (新增 findByCliSessionId 不冲突) ───────
const repoIndexFile = join(REPO_ROOT, 'src/main/store/session-repo/index.ts');
const repoFunctions = grepFile(repoIndexFile, /export\s+(const|function)\s+\w+/);
console.log(`\n[spike4.3] sessionRepo 现有 export 接口 (新增 findByCliSessionId 路径):`);
repoFunctions.slice(0, 20).forEach((h) => console.log(`  L${h.line}: ${h.text}`));

// ─── 4.4 v020 migration 文件结构 (类比 v021 cli_session_id) ─────────────
const v020 = join(REPO_ROOT, 'src/main/store/migrations/v020_sessions_cwd_release_marker.sql');
console.log(`\n[spike4.4] v020 migration 模板 (类比 v021 cli_session_id 加列模式):`);
const v020Content = readFileSync(v020, 'utf-8');
const lastLines = v020Content.split('\n').slice(-5).join('\n');
console.log(`  ${lastLines}`);

// ─── 4.5 现有 fork detect 路径 set recentlyDeleted (manager.ts:480) ──────
const renameDeleted = grepFile(managerFile, /this\.recentlyDeleted\.set\(fromId/);
console.log(`\n[spike4.5] renameSdkSession 内 recentlyDeleted.set(fromId) 调用:`);
renameDeleted.forEach((h) => console.log(`  L${h.line}: ${h.text}`));

// ─── 4.6 hook event sid 来源 (CLI 子进程 body.session_id) ────────────────
console.log(`\n[spike4.6] hook event sid 来源链:`);
console.log(`  - CLI 子进程 hook curl POST body.session_id (CLI 内部 thread sid)`);
console.log(`  - hook-routes.ts:28 校验 body.session_id`);
console.log(`  - translate.ts:31 sessionId: p.session_id (hook event AgentEvent.sessionId)`);
console.log(`  - manager.ts:224 isRecentlyDeleted(event.sessionId) 早返`);
console.log(`  - 反向 rename 后 event.sessionId 是 NEW_CLI_ID,findByCliSessionId 反查 → application sid`);

// ─── 4.7 D7 修法路径推论 ────────────────────────────────────────────────
console.log(`\n[spike4.7] D7 修法推论 (反向 rename 后 ingest 流程):`);
console.log(`  Step 1: ingest(event) 入口拿到 event.sessionId = NEW_CLI_ID`);
console.log(`  Step 2: appSid = sessionRepo.findByCliSessionId(event.sessionId)`);
console.log(`  Step 3a: 找到 → event.sessionId = appSid (覆写为 application sid),走正常 dedupOrClaim → ensureRecord`);
console.log(`  Step 3b: 找不到 + isRecentlyDeleted(event.sessionId) 命中 → 丢弃迟到 event`);
console.log(`  Step 3c: 找不到 + 不在黑名单 + cwd 命中 pendingSdkCwds → 时序兜底 claim`);
console.log(`  Step 3d: 全没命中 → ensureRecord 新建外部 CLI 会话 (现状 fallback,不变)`);

console.log('\n[spike4] 完成。结论 inline 进 spike4-late-hook-event.md');
