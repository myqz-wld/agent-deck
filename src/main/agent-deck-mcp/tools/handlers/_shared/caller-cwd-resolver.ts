/**
 * Read the caller session row when an MCP handler needs caller cwd context.
 * The helper collects warnings and leaves logging to the caller.
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
