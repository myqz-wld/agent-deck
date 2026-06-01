/**
 * _shared/caller-cwd-resolver.ts —— archive_plan + hand_off_session 共享的 caller session row
 * 反查原语（Follow-up #7 修法）。
 *
 * **抽出动机**（Follow-up #7 / user CLAUDE.md 提示词资产维护 §约束 1「多处出现同款规则抽到
 * 一处」）：archive-plan.ts `resolveCallerCwdDeps`(L104) 与 hand-off-session/cwd-resolver.ts
 * `resolveCallerCwdDeps`(L57) 两处对同一 callerSessionId 各写了一份「external sentinel 短路 +
 * 一次 sessionRepo.get + try/catch fail-open + row null warning + warnings 收集」逻辑（REVIEW_56
 * §F9 引入时两端就是对称复制,作者注释明示「signature 与 archive-plan 同款保持对称易维护」）。
 * 两处行为字节级一致,只是后续 row→deps 的字段映射不同(archive 注入 cwd + cwdReleaseMarker /
 * hand-off 仅 cwd)。
 *
 * **抽出边界**:本文件只抽**共性原语** `fetchCallerSessionRow`(external sentinel 短路 + 一次
 * sessionRepo.get + try/catch fail-open + warnings 收集),**不**抽 row→deps 映射(两端字段不同,
 * 抽 generic factory 让类型 inference 变复杂得不偿失 — 对齐 user CLAUDE.md §大文件拆分实战经验
 * 「不预先抽 _shared/ 大坨」)。两端 caller 各自拿 `{ row, warnings }` 后做自己的 deps 装配。
 *
 * **纯函数 — 不 logging**:本 helper 只收集 warnings 不 logger.warn(原两端 fail-open 退化的
 * operator-log 策略不同:archive 走 ok return.warnings + operator log,hand-off 走 operator log。
 * 为不在 helper 里耦合两端的 logging 策略,helper 保持纯收集,operator log 由各 handler 自己 loop
 * warnings 输出)。
 *
 * **Follow-up #2 协同**:hand-off handler-main 把本 helper 的一次反查结果 `row` 透传给
 * mergeCallerCwd + resolveCallerSessionCwd 两个 resolver(各加可选 `prefetchedRow` 参数),
 * 避免对同一 callerSessionId 落两次 DB(原 mergeCallerCwd + resolveCallerSessionCwd 各反查一次)。
 */

import type { SessionRecord } from '@shared/types';
import { sessionRepo } from '@main/store/session-repo';
import { EXTERNAL_CALLER_SENTINEL } from '../../../types';

/**
 * 一次反查 caller session row,带 external sentinel 短路 + try/catch fail-open + warnings 收集。
 * 纯函数,不 logger.warn(operator log 由 caller handler 自己 loop warnings)。
 *
 * - external sentinel(`__external__`)→ `{ row: null, warnings: [] }`(deny external 已在 handler
 *   层拦下,这里双保险短路不查 DB)
 * - sessionRepo.get 抛错(test 未 init DB / 生产 SQLite locked / FK conflict)→ `{ row: null,
 *   warnings: [<throw 退化 msg>] }`
 * - row 为 null(caller session 不在 sessions 表)→ `{ row: null, warnings: [<not-found msg>] }`
 * - row 命中 → `{ row, warnings: [] }`
 *
 * @param toolName warning message 前缀(`archive-plan` / `hand-off-session`)让 caller loop 输出到
 *   operator log 时易定位是哪个 tool 的 fail-open 退化。
 */
export function fetchCallerSessionRow(
  callerSessionId: string,
  toolName: 'archive-plan' | 'hand-off-session',
): { row: SessionRecord | null; warnings: string[] } {
  const warnings: string[] = [];
  if (callerSessionId === EXTERNAL_CALLER_SENTINEL) return { row: null, warnings };
  let row: SessionRecord | null = null;
  try {
    row = sessionRepo.get(callerSessionId);
  } catch (e) {
    warnings.push(
      `[${toolName}] sessionRepo.get(${callerSessionId}) threw — falling back to DEFAULT_DEPS. err=${e instanceof Error ? e.message : String(e)}`,
    );
    return { row: null, warnings };
  }
  if (!row) {
    warnings.push(
      `[${toolName}] sessionRepo.get(${callerSessionId}) returned null — caller session not found, falling back to DEFAULT_DEPS`,
    );
  }
  return { row, warnings };
}
