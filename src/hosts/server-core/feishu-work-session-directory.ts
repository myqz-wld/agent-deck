import type { GetSessionResult } from '@main/agent-deck-mcp/tools/schemas';
import type { SessionRecord } from '@shared/types';
import type { FeishuAssistantStore } from './feishu-assistant-store';

export interface FeishuWorkSessionListArgs { limit?: number; offset?: number }
export interface FeishuWorkSessionListResult {
  scope: 'open-work-sessions';
  assistantSessionId: string;
  sessions: GetSessionResult[];
  nextOffset: number | null;
  hasMore: boolean;
}
export interface FeishuWorkSessionDirectoryPort {
  list(callerId: string, args: FeishuWorkSessionListArgs): FeishuWorkSessionListResult;
}
const SCAN_PAGE_SIZE = 200;
const SCAN_BUDGET = 2_000;

/** Purpose is owner-attested, independent of titles, model selections and collaboration lineage. */
export class FeishuWorkSessionDirectory implements FeishuWorkSessionDirectoryPort {
  constructor(private readonly options: {
    assistants: Pick<FeishuAssistantStore, 'read'>;
    sessions: { get(id: string): SessionRecord | null; listActiveAndDormant(limit: number, offset: number): SessionRecord[] };
    successor(sessionId: string): string | null;
    project(callerId: string, sessionId: string): GetSessionResult;
  }) {}

  list(callerId: string, args: FeishuWorkSessionListArgs): FeishuWorkSessionListResult {
    const limit = args.limit ?? 50;
    let offset = args.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) ||
      offset < 0 || offset > Number.MAX_SAFE_INTEGER - SCAN_BUDGET) throw new Error('Invalid work-session page');
    const caller = this.options.sessions.get(callerId);
    const ids = new Set(this.options.assistants.read());
    // Resolve each alias once instead of multiplying lineage queries by every candidate row.
    for (const id of ids) {
      if (ids.size > 16_384) throw new Error('Assistant ownership directory exceeds its bound');
      const successor = this.options.successor(id);
      if (successor) ids.add(successor);
    }
    if (!caller || caller.lifecycle === 'closed' || caller.archivedAt !== null ||
      caller.hiddenFromHistory || !ids.has(callerId)) throw new Error('Registered assistant caller is unavailable');
    const sessions: GetSessionResult[] = [];
    const result = (nextOffset: number | null): FeishuWorkSessionListResult => ({
      scope: 'open-work-sessions', assistantSessionId: callerId, sessions,
      nextOffset, hasMore: nextOffset !== null,
    });
    let scanned = 0;
    while (scanned < SCAN_BUDGET) {
      const take = Math.min(SCAN_PAGE_SIZE, SCAN_BUDGET - scanned);
      const rows = this.options.sessions.listActiveAndDormant(take, offset);
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]!;
        offset++; scanned++;
        if (!row.hiddenFromHistory && row.archivedAt === null && row.lifecycle !== 'closed' && !ids.has(row.id)) {
          sessions.push(this.options.project(callerId, row.id));
        }
        if (sessions.length === limit) {
          return result(index + 1 < rows.length || rows.length === take ? offset : null);
        }
      }
      if (rows.length < take) return result(null);
    }
    return result(offset);
  }
}
