import type { Database } from 'better-sqlite3';

interface UsageValues {
  total: number | null;
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheCreation: number | null;
}

interface LegacyClaudeRow extends UsageValues {
  id: number;
  sessionId: string | null;
  messageId: string;
  modelRaw: string;
  modelBucket: string;
  ts: number;
  unattributedReasoning: number;
}

interface RepairGroupState {
  watermark: UsageValues;
  seenLegacyRow: boolean;
}

export interface TokenUsageLegacyRepairSummary {
  claudeCumulativeRows: number;
  codexContextOnlyRows: number;
}

const LEGACY_CLAUDE_PREDICATE = `
  (message_id GLOB 'result:*:model:*'
   OR message_id GLOB 'result:*:reasoning:unattributed')
`;

/**
 * Repair only rows whose old wire shape proves they were persisted with known-bad semantics.
 * Message-id renaming makes the operation idempotent without adding schema or migration state.
 */
export function repairLegacyTokenUsage(
  db: Database,
): TokenUsageLegacyRepairSummary {
  return db.transaction(() => {
    const claudeCumulativeRows = repairLegacyClaudeRows(db);
    const codexContextOnlyRows = db.prepare(`
      DELETE FROM token_usage
       WHERE agent_id = 'codex-cli'
         AND message_id IS NULL
         AND total_tokens > 0
         AND input_tokens = 0
         AND output_tokens = 0
         AND reasoning_tokens = 0
         AND cache_read_tokens = 0
         AND cache_creation_tokens = 0
    `).run().changes;
    return { claudeCumulativeRows, codexContextOnlyRows };
  })();
}

function repairLegacyClaudeRows(db: Database): number {
  const rows = db.prepare(`
    SELECT id,
           session_id AS sessionId,
           message_id AS messageId,
           model_raw AS modelRaw,
           model_bucket AS modelBucket,
           total_tokens AS total,
           input_tokens AS input,
           output_tokens AS output,
           reasoning_tokens AS reasoning,
           cache_read_tokens AS cacheRead,
           cache_creation_tokens AS cacheCreation,
           ts,
           CASE WHEN message_id GLOB 'result:*:reasoning:unattributed'
                THEN 1 ELSE 0 END AS unattributedReasoning
      FROM token_usage
     WHERE agent_id = 'claude-code'
       AND ${LEGACY_CLAUDE_PREDICATE}
     ORDER BY session_id, unattributedReasoning, model_raw, ts, id
  `).all() as LegacyClaudeRow[];
  if (rows.length === 0) return 0;

  const update = db.prepare(`
    UPDATE token_usage
       SET message_id = ?,
           total_tokens = ?,
           input_tokens = ?,
           output_tokens = ?,
           reasoning_tokens = ?,
           cache_read_tokens = ?,
           cache_creation_tokens = ?
     WHERE id = ?
       AND message_id = ?
  `);
  const groups = new Map<string, RepairGroupState>();
  let repaired = 0;
  for (const row of rows) {
    const key = repairGroupKey(row);
    let state = groups.get(key);
    if (!state) {
      state = {
        watermark: readPriorAdditiveBaseline(db, row),
        seenLegacyRow: false,
      };
      groups.set(key, state);
    }
    const current = valuesFromRow(row);
    const reset = state.seenLegacyRow && hasCumulativeReset(current, state.watermark);
    const delta = subtractUsage(current, reset ? emptyUsage() : state.watermark);
    state.watermark = mergeUsage(state.watermark, current);
    state.seenLegacyRow = true;
    const nextMessageId = `repaired-result-delta-v2:${row.messageId.slice('result:'.length)}`;
    repaired += update.run(
      nextMessageId,
      delta.total,
      delta.input,
      delta.output,
      delta.reasoning,
      delta.cacheRead,
      delta.cacheCreation,
      row.id,
      row.messageId,
    ).changes;
  }
  return repaired;
}

function readPriorAdditiveBaseline(
  db: Database,
  row: LegacyClaudeRow,
): UsageValues {
  const modelPredicate = row.unattributedReasoning === 1
    ? '1 = 1'
    : 'model_raw = @modelRaw';
  const baseline = db.prepare(`
    SELECT SUM(total_tokens) AS total,
           SUM(input_tokens) AS input,
           SUM(output_tokens) AS output,
           SUM(reasoning_tokens) AS reasoning,
           SUM(cache_read_tokens) AS cacheRead,
           SUM(cache_creation_tokens) AS cacheCreation
      FROM token_usage
     WHERE agent_id = 'claude-code'
       AND session_id IS @sessionId
       AND ${modelPredicate}
       AND (ts < @ts OR (ts = @ts AND id < @id))
       AND NOT ${LEGACY_CLAUDE_PREDICATE}
  `).get({
    sessionId: row.sessionId,
    ts: row.ts,
    id: row.id,
    ...(row.unattributedReasoning === 1 ? {} : { modelRaw: row.modelRaw }),
  }) as UsageValues;
  return {
    total: baseline.total ?? 0,
    input: baseline.input ?? 0,
    output: baseline.output ?? 0,
    reasoning: baseline.reasoning ?? 0,
    cacheRead: baseline.cacheRead ?? 0,
    cacheCreation: baseline.cacheCreation ?? 0,
  };
}

function repairGroupKey(row: LegacyClaudeRow): string {
  return row.unattributedReasoning === 1
    ? `${row.sessionId ?? ''}\0reasoning`
    : `${row.sessionId ?? ''}\0model\0${row.modelRaw}`;
}

function valuesFromRow(row: LegacyClaudeRow): UsageValues {
  return {
    total: row.total,
    input: row.input,
    output: row.output,
    reasoning: row.reasoning,
    cacheRead: row.cacheRead,
    cacheCreation: row.cacheCreation,
  };
}

function subtractUsage(current: UsageValues, previous: UsageValues): UsageValues {
  return mapUsage(current, (value, field) =>
    Math.max(value - (previous[field] ?? 0), 0));
}

function mergeUsage(previous: UsageValues, current: UsageValues): UsageValues {
  return {
    total: current.total ?? previous.total,
    input: current.input ?? previous.input,
    output: current.output ?? previous.output,
    reasoning: current.reasoning ?? previous.reasoning,
    cacheRead: current.cacheRead ?? previous.cacheRead,
    cacheCreation: current.cacheCreation ?? previous.cacheCreation,
  };
}

function hasCumulativeReset(current: UsageValues, previous: UsageValues): boolean {
  return usageFields().some((field) => {
    const value = current[field];
    const before = previous[field];
    return value !== null && before !== null && value < before;
  });
}

function mapUsage(
  source: UsageValues,
  fn: (value: number, field: keyof UsageValues) => number,
): UsageValues {
  return {
    total: source.total === null ? null : fn(source.total, 'total'),
    input: source.input === null ? null : fn(source.input, 'input'),
    output: source.output === null ? null : fn(source.output, 'output'),
    reasoning: source.reasoning === null ? null : fn(source.reasoning, 'reasoning'),
    cacheRead: source.cacheRead === null ? null : fn(source.cacheRead, 'cacheRead'),
    cacheCreation:
      source.cacheCreation === null
        ? null
        : fn(source.cacheCreation, 'cacheCreation'),
  };
}

function usageFields(): Array<keyof UsageValues> {
  return ['total', 'input', 'output', 'reasoning', 'cacheRead', 'cacheCreation'];
}

function emptyUsage(): UsageValues {
  return { total: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheCreation: 0 };
}
