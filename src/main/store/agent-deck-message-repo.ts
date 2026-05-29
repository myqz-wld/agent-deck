/**
 * Agent Deck Universal Team Backend message repo（R3.E3 / E0 ADR §4）— facade。
 *
 * 持久层：agent_deck_messages 表 CRUD + watcher 关键 helpers。
 *
 * **Phase 4 Step 4.11 拆分**（沿用 Step 4.5 task-repo 同款 factory pattern）：
 * 本文件已从 527 LOC facade 化（薄 re-export + factory 装配 + singleton lazy）。13 method
 * 按 ADR §4 状态机分三域:
 * - `./crud.ts` — insert / get / listByTeam / listBySession（4 method 基础读写）
 * - `./dispatch.ts` — findEligible / findEligibleExcludingTargets / countPendingForTarget
 *   （3 method watcher 配对查询）
 * - `./state-machine.ts` — claim / markDelivered / markFailed / retryAfterFail / cancel /
 *   resetDeliveringOnStartup（6 method 状态机迁移）
 * - `./_deps.ts` — MessageRow + rowToRecord + 4 Input shapes + AgentDeckMessageRepo interface
 *   + getById free function（state-machine UPDATE 后反查最新 row 共享 SELECT）
 *
 * 设计要点：
 * - 同步 SQL（与 task-repo / session-repo / agent-deck-team-repo 风格一致）
 * - WAL + 单进程，FK 在 db.ts 内已启用
 * - 通过 `createAgentDeckMessageRepo(db)` 工厂注入 db；默认导出 `agentDeckMessageRepo` 懒拿 getDb()
 *
 * 状态机（ADR §4.3）：
 *   pending → claim → delivering →
 *     ↓ success: delivered (terminal)
 *     ↓ throw:   pending (attempt_count++ + last_attempt_at=now) | failed (>= MAX_RETRY)
 *   或 cancelled (terminal, 来自显式 cancel API)
 *
 * 关键修法（reviewer 双对抗）：
 * - HIGH-1：用 last_attempt_at 而非 sent_at 做退避基准（findEligible WHERE 子句）
 * - HIGH-1 / MED-2：MAX_RETRY=3，attempt_count 取值 {0,1,2,3}，3 直接 failed
 * - §4.6：crash recovery 不无条件 ++attempt_count（resetDeliveringOnStartup）
 * - 自循环防御：caller-side insert 校验 from != to
 * - 100KB body：caller-side validation + SQLite CHECK 兜底
 *
 * **CHANGELOG_109 / R37 P2-N Step 3.6**：状态机常量（MAX_RETRY / MAX_BODY_LENGTH /
 * BACKOFF_TIERS / VALID_MESSAGE_STATUSES）+ 纯 helpers（backoffMs / coerceMessageStatus /
 * buildFindEligibleWhereSql）+ MessageInvariantError 已抽到 `./message-delivery-state.ts`，
 * 本文件 re-export 全部 named export 保 back-compat（外部 caller 无须改 import 路径）。
 * 新代码请直接从 `@main/store/message-delivery-state` import；本文件保持只暴露 repo +
 * factory + input shapes 的 narrow API。
 */
import type { Database } from 'better-sqlite3';
import { getDb } from './db';
import {
  BACKOFF_TIERS,
  MAX_BODY_LENGTH,
  MAX_RETRY,
  MessageInvariantError,
  buildFindEligibleWhereSql,
  coerceMessageStatus,
  backoffMs,
} from './message-delivery-state';
import { createCrud } from './agent-deck-message-repo/crud';
import { createDispatch } from './agent-deck-message-repo/dispatch';
import { createStateMachine } from './agent-deck-message-repo/state-machine';

// back-compat re-export（旧 caller 仍可 `from '@main/store/agent-deck-message-repo'` 取常量）
export {
  BACKOFF_TIERS,
  MAX_BODY_LENGTH,
  MAX_RETRY,
  MessageInvariantError,
  backoffMs,
  buildFindEligibleWhereSql,
  coerceMessageStatus,
};

// 类型 + interface re-export（外部 caller 不感知子模块拆分）
export type {
  AgentDeckMessageRepo,
  FindEligibleExcludingTargetsOptions,
  FindEligibleOptions,
  InsertMessageInput,
  ListMessagesByTeamOptions,
} from './agent-deck-message-repo/_deps';

import type { AgentDeckMessageRepo } from './agent-deck-message-repo/_deps';

export function createAgentDeckMessageRepo(db: Database): AgentDeckMessageRepo {
  const crud = createCrud(db);
  const dispatch = createDispatch(db);
  const state = createStateMachine(db);
  return {
    ...crud,
    ...dispatch,
    ...state,
  };
}

/** 默认 repo：模块加载时 getDb() 还没 init，不能 eager 构造；缓存到模块 closure */
let _defaultRepo: AgentDeckMessageRepo | null = null;
function defaultRepo(): AgentDeckMessageRepo {
  if (!_defaultRepo) _defaultRepo = createAgentDeckMessageRepo(getDb());
  return _defaultRepo;
}

export const agentDeckMessageRepo: AgentDeckMessageRepo = {
  insert: (input) => defaultRepo().insert(input),
  get: (messageId) => defaultRepo().get(messageId),
  listByTeam: (teamId, opts) => defaultRepo().listByTeam(teamId, opts),
  listBySession: (sessionId, opts) => defaultRepo().listBySession(sessionId, opts),
  findEligible: (opts) => defaultRepo().findEligible(opts),
  findEligibleExcludingTargets: (opts) => defaultRepo().findEligibleExcludingTargets(opts),
  claim: (messageId, now) => defaultRepo().claim(messageId, now),
  markDelivered: (messageId, now) => defaultRepo().markDelivered(messageId, now),
  markFailed: (messageId, reason) => defaultRepo().markFailed(messageId, reason),
  retryAfterFail: (messageId, reason, now) => defaultRepo().retryAfterFail(messageId, reason, now),
  cancel: (messageId, reason) => defaultRepo().cancel(messageId, reason),
  countPendingForTarget: (toSessionId) => defaultRepo().countPendingForTarget(toSessionId),
  resetDeliveringOnStartup: () => defaultRepo().resetDeliveringOnStartup(),
};
