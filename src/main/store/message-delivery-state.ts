/**
 * message-delivery-state.ts —— agent_deck_messages 投递状态机 SSOT（CHANGELOG_109，
 * R37 P2-N Step 3.6 / codex 11 LOW finding）。
 *
 * **抽出动机**：在重构前 `agent-deck-message-repo.ts` 同时管 SQL CRUD + 状态机常量
 * （MAX_RETRY / backoff 表 / VALID_STATUSES / SQL CASE 分支硬编码 1000ms 4000ms）。
 * codex 11 LOW finding：JS 端 `backoffMs()` helper 与 SQL findEligible 内 hardcode 的
 * `+ 1000`/`+ 4000` 字面量是「同款常量两份声明」，要改 backoff 表必须 JS / SQL 双改 +
 * 双查所有 test 引用。本文件抽出后 SQL CASE 分支由 `BACKOFF_TIERS` 表自动渲染（构建期
 * 字符串拼接），SSOT 单点；改 backoff tier 只动 BACKOFF_TIERS 数组、`backoffMs()` /
 * SQL fragment / test 全部自动跟着对。
 *
 * **edge constraint**：`MAX_RETRY` 与 `BACKOFF_TIERS.length` 必须满足
 * `MAX_RETRY === BACKOFF_TIERS.length + 1`（attempt {0,1,...,BACKOFF_TIERS.length} 都
 * eligible，attempt = MAX_RETRY 触发 markFailed 永远不进 findEligible）。本文件加 module
 * load 期 invariant 自检，违例 throw 阻止 db.ts init —— 比 prod 路径出现 retry 死循环 /
 * 不该 fail 的 message 提前 fail 早死。
 *
 * **范围**（不引入新功能，纯 extract + 抽公共 SSOT）：
 * - `MAX_RETRY` / `MAX_BODY_LENGTH` / `BACKOFF_TIERS` 常量
 * - `backoffMs()` / `coerceMessageStatus()` / `buildFindEligibleWhereSql()` 纯函数
 * - `MessageInvariantError` class
 * - `VALID_MESSAGE_STATUSES` readonly 数组
 *
 * **不**含：DB 操作 / row → record 转换 / 任何 better-sqlite3 引用。Repo 端 `import` 此
 * 文件取常量，Repo 不需反向依赖（保持单向：repo → state，不出现 repo ⇆ state cycle）。
 *
 * **back-compat**：`agent-deck-message-repo.ts` re-export 全部 named export，外部 caller
 * （universal-message-watcher / tests）无须改 import 路径。Re-export 允许直接从两处
 * import 等价，但**新代码请直接 import** `@main/store/message-delivery-state`，让
 * agent-deck-message-repo.ts 保持只暴露 repo + 一组 type 的 narrow API。
 */

import type { AgentDeckMessage, AgentDeckMessageStatus } from '@shared/types';
import log from '@main/utils/logger';

const logger = log.scope('store-message-delivery');

// ────────────────────────────────────────────────────────────────────────────
// Errors
// ────────────────────────────────────────────────────────────────────────────

export class MessageInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageInvariantError';
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

/**
 * 单条 body 长度上限（字符数，**非** 字节数，与 SQLite CHECK 同款）。
 *
 * REVIEW_24 HIGH-2 follow-up：与 sdk-bridge MAX_MESSAGE_LENGTH（claude-code）/
 * codex-cli adapter / ipc/sessions.ts finalPrompt /
 * ipc/adapters.ts AdapterCreateSession + AdapterSendMessage 5 处 102_400 全局对齐。
 * 改这里必须同步那 4 处（grep `102_400` 确认）。
 */
export const MAX_BODY_LENGTH = 102_400;

/**
 * 退避表（ADR §4.3 / reviewer HIGH-1 修法）：attempt_count → 距 last_attempt_at 至少 N ms 后才
 * 再次 eligible。
 *
 * 当前生效 schedule：
 * - attempt_count = 0 → 0ms（catch-all：last_attempt_at IS NULL OR attempt_count = 0）
 * - attempt_count = 1 → 1_000ms
 * - attempt_count = 2 → 4_000ms
 * - attempt_count = 3 → never eligible（直接 failed，不进 status='pending'）
 *
 * **SSOT**：JS 端 `backoffMs()` 与 SQL findEligible WHERE 子句都从此表派生（详
 * `buildFindEligibleWhereSql()`）。新增 tier 三步：
 * 1. 在 BACKOFF_TIERS 加新 entry（如 `[3, 9_000]`）
 * 2. 把 MAX_RETRY 加 1（保持不变量 `MAX_RETRY === BACKOFF_TIERS.length + 1`）
 * 3. 跑 vitest（test 自动覆盖新 tier）
 *
 * 数组格式 `[attemptCount, delayMs]`，attempt_count 严格升序、连续整数 1..N。运行期 invariant
 * 自检（detail 见文件顶部）违例 throw。
 */
export const BACKOFF_TIERS: ReadonlyArray<readonly [attemptCount: number, delayMs: number]> = [
  [1, 1_000],
  [2, 4_000],
];

/**
 * 最大尝试次数：attempt_count 取值 {0,1,...,MAX_RETRY-1} 都可重投，到 MAX_RETRY 触发 markFailed
 * 永远不进 findEligible。当前 MAX_RETRY=3 = BACKOFF_TIERS.length(2) + 1。
 *
 * 改此值必须同步 BACKOFF_TIERS（详 BACKOFF_TIERS jsdoc Step 1-3）。
 */
export const MAX_RETRY = 3;

/**
 * Status enum SSOT。SQL CHECK constraint（migrations/0007 / 0010）独立声明同款集合 —— 不
 * 自动同步（migration 是 frozen pl text 不能 import TS const），但 invariant 测试覆盖
 * （`agent-deck-message-repo.test.ts` `100KB 边界` 等 case 间接验证）。新增 status 必须：
 * (a) 加新 migration ALTER CHECK 约束；(b) 加到此数组末尾；(c) 加到 `coerceMessageStatus()`
 * fallback case；(d) 至少加 1 个 test case。
 */
export const VALID_MESSAGE_STATUSES = [
  'pending',
  'delivering',
  'delivered',
  'failed',
  'cancelled',
] as const satisfies ReadonlyArray<AgentDeckMessageStatus>;

// ────────────────────────────────────────────────────────────────────────────
// Module load invariant 自检
// ────────────────────────────────────────────────────────────────────────────

(function assertInvariants(): void {
  if (MAX_RETRY !== BACKOFF_TIERS.length + 1) {
    throw new Error(
      `[message-delivery-state] invariant violation: MAX_RETRY (${MAX_RETRY}) !== BACKOFF_TIERS.length (${BACKOFF_TIERS.length}) + 1`,
    );
  }
  // BACKOFF_TIERS.attemptCount 必须严格升序连续整数 1..N（findEligible SQL 假设此布局）
  for (let i = 0; i < BACKOFF_TIERS.length; i++) {
    const expected = i + 1;
    const actual = BACKOFF_TIERS[i][0];
    if (actual !== expected) {
      throw new Error(
        `[message-delivery-state] BACKOFF_TIERS[${i}] attemptCount=${actual} expected ${expected} (must be 1..N strictly increasing)`,
      );
    }
    if (BACKOFF_TIERS[i][1] < 0) {
      throw new Error(
        `[message-delivery-state] BACKOFF_TIERS[${i}] delayMs negative (got ${BACKOFF_TIERS[i][1]})`,
      );
    }
  }
})();

// ────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * 退避表 JS 镜像。**严禁** prod 路径调（findEligible 走 SQL CASE 直接展开常量），保留是为：
 * (a) 文档化 attempt_count → backoff 语义；(b) test 可 import 同款表做对照断言。
 *
 * REVIEW_35 LOW-A3：本函数仅 unit test 内引用，prod 路径完全不调。Step 3.6 抽到本文件
 * （从 BACKOFF_TIERS 表派生）后再无双声明漂移风险。
 */
export function backoffMs(attemptCount: number): number {
  if (attemptCount <= 0) return 0;
  const tier = BACKOFF_TIERS.find(([n]) => n === attemptCount);
  if (tier) return tier[1];
  // attempt_count >= MAX_RETRY：never eligible（调用方应已 markFailed）
  return Number.MAX_SAFE_INTEGER;
}

/**
 * 构造 findEligible() WHERE 子句（仅退避部分，不含 status='pending'）。从 BACKOFF_TIERS
 * 派生 SQL 字符串 + ? placeholder 数（每 tier 一个 ? 绑定 now）。
 *
 * 返回 `whereSql` 形如：
 * ```
 * last_attempt_at IS NULL
 *   OR attempt_count = 0
 *   OR (attempt_count = 1 AND last_attempt_at + 1000 <= ?)
 *   OR (attempt_count = 2 AND last_attempt_at + 4000 <= ?)
 * ```
 *
 * **`attempt_count = 0` clause 的必要性**：仅 `last_attempt_at IS NULL` 不够。`claim()`
 * 把 last_attempt_at 设为 now 再投递，若崩溃 `resetDeliveringOnStartup()` 把行重置为
 * pending 但**不**清 last_attempt_at（也不 ++attempt_count，详 §4.6 reviewer HIGH-1
 * 修法），此时 attempt_count=0 但 last_attempt_at 非 NULL。两 clause 各自独立兜底，缺一
 * 不可。
 *
 * **不**自动加 `status = 'pending'` 前缀 —— caller 自己拼，避免本 helper 侵入 repo SQL
 * 结构（保持「只供 backoff 段 SSOT」narrow contract）。
 */
export function buildFindEligibleWhereSql(): {
  /** WHERE 子句的退避部分（不含 status='pending'，caller 自拼） */
  whereSql: string;
  /** ? placeholder 个数（caller 须传等量 `now` 绑定值） */
  backoffPlaceholderCount: number;
} {
  const tierClauses = BACKOFF_TIERS.map(
    ([n, ms]) => `(attempt_count = ${n} AND last_attempt_at + ${ms} <= ?)`,
  );
  const whereSql = ['last_attempt_at IS NULL', 'attempt_count = 0', ...tierClauses].join(
    '\n             OR ',
  );
  return { whereSql, backoffPlaceholderCount: BACKOFF_TIERS.length };
}

/**
 * 防御性把 DB row.status 字符串收口到 typed enum。SQL CHECK constraint（migrations）
 * 理论上挡掉所有非法值，但 (a) 跨 migration 期间历史脏数据；(b) 应用启动 race（先
 * read 后 migrate）—— 兜底 fallback `failed` 不抛错。
 *
 * **注意**：caller 端拿到 `failed` 时无法区分「真 failed」vs「coerce 兜底」。如未来需要
 * 区分，加 `coerceResult: 'valid' | 'fallback'` 字段返回。
 */
export function coerceMessageStatus(raw: string): AgentDeckMessageStatus {
  if ((VALID_MESSAGE_STATUSES as readonly string[]).includes(raw)) {
    return raw as AgentDeckMessageStatus;
  }
  // REVIEW_56 §F14 修法 (Plan-Review Round 1 + spike 决策): 加 console.warn 让运维感知脏数据。
  // 函数签名只接 `raw` 不接 `id`,加 id 需链上多 caller refactor 成本高,prefix `[message-delivery-state]`
  // + raw value 足够 ops 通过 grep 定位。
  logger.warn(`[message-delivery-state] unknown status "${raw}" coerced to 'failed'`);
  return 'failed';
}

/**
 * 状态机 type-only re-export，避免 repo 重 import shared/types。
 * caller 直接 `import type { AgentDeckMessage }` from shared/types 也行。
 */
export type { AgentDeckMessage, AgentDeckMessageStatus };
