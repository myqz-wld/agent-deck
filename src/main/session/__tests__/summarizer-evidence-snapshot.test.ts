import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { AgentEvent, SummaryRecord } from '@shared/types';
import { MIGRATIONS } from '@main/store/migrations';
import { bindingAvailable } from '@main/store/__tests__/_binding-probe';
import { createContinuationCheckpointRepo } from '@main/store/continuation-checkpoint-repo';
import { createEventRevisionRepo } from '@main/store/event-revision-repo';
import { formatEventsForPrompt } from '../summarizer/event-formatter';
import { capturePeriodicSummaryEvidence } from '../summarizer/evidence-snapshot';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  db.prepare(
    `INSERT INTO sessions
       (id, agent_id, cwd, title, source, lifecycle, activity, started_at, last_event_at)
     VALUES ('summary-evidence', 'claude-code', '/repo', 'summary', 'sdk',
             'active', 'working', 1, 1)`,
  ).run();
  return db;
}

function insertEvent(
  db: Database.Database,
  kind: AgentEvent['kind'],
  payload: unknown,
  ts: number,
): number {
  return Number(
    db.prepare(
      `INSERT INTO events (session_id, kind, payload_json, ts)
       VALUES ('summary-evidence', ?, ?, ?)`,
    ).run(kind, JSON.stringify(payload), ts).lastInsertRowid,
  );
}

function previous(revision: number | null): SummaryRecord {
  return {
    id: 1,
    sessionId: 'summary-evidence',
    content: '旧标题\n进展：旧进展',
    trigger: 'time',
    ts: 2,
    sourceEventRevision: revision,
    sourceRebuildAfterRevision: revision === null ? null : 0,
    generationSource: revision === null ? 'legacy' : 'llm',
  };
}

describe.skipIf(!bindingAvailable)('periodic summary evidence snapshot', () => {
  it('reuses continuation classification for user intent and includes bounded tool results', () => {
    const db = makeDb();
    try {
      insertEvent(db, 'message', { role: 'user', text: '优化周期总结，明确进展和下一步' }, 10);
      insertEvent(db, 'message', { role: 'user', text: 'do not retain', synthetic: true }, 11);
      insertEvent(db, 'message', { role: 'assistant', text: '正在定位总结输入缺口' }, 12);
      db.prepare(
        `INSERT INTO events (session_id, kind, payload_json, ts)
         VALUES ('summary-evidence', 'message', '{malformed', 12)`,
      ).run();
      insertEvent(db, 'tool-use-end', {
        toolName: 'Bash',
        status: 'completed',
        toolResult: { stdout: '12 tests passed' },
      }, 13);

      const snapshot = capturePeriodicSummaryEvidence('summary-evidence', null, db);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.promptContext).toContain('优化周期总结');
      expect(snapshot!.promptContext).not.toContain('do not retain');
      expect(snapshot!.promptContext).not.toContain('malformed');
      expect(formatEventsForPrompt(snapshot!.events)).toContain(
        '[Claude 工具结果] Bash · 完成 · {"stdout":"12 tests passed"}',
      );
      expect(snapshot!.events.map((event) => event.kind)).toContain('message');
      expect(snapshot!.events.map((event) => event.kind)).toContain('tool-use-end');
    } finally {
      db.close();
    }
  });

  it('projects only a validated checkpoint at or before the captured revision', () => {
    const db = makeDb();
    try {
      const eventId = insertEvent(
        db,
        'message',
        { role: 'user', text: '保留既定目标' },
        20,
      );
      const state = createEventRevisionRepo(db).state('summary-evidence')!;
      const result = createContinuationCheckpointRepo(db).commit({
        sessionId: 'summary-evidence',
        expectedHeadId: null,
        expectedRebuildAfterRevision: state.rebuildAfterRevision,
        sourceEventRevision: state.revision,
        sourceMaxEventId: eventId,
        checkpoint: {
          formatVersion: 1,
          goals: [{
            id: 'goal.summary-quality',
            status: 'active',
            text: '让周期总结展示明确目标、进展和下一步',
            priority: 90,
            evidence: [{ eventId, revision: state.revision }],
          }],
          userIntent: [], constraints: [], decisions: [], completedWork: [],
          currentState: [], nextSteps: [], openQuestions: [], risks: [], keyFiles: [],
          commands: [], unresolvedErrors: [],
        },
        generatorAdapter: 'claude-code',
        generatorModel: 'sonnet',
        generatorThinking: 'medium',
        trigger: 'test',
      });
      expect(result.ok).toBe(true);

      const snapshot = capturePeriodicSummaryEvidence('summary-evidence', null, db)!;
      expect(snapshot.promptContext).toContain('让周期总结展示明确目标、进展和下一步');
      expect(snapshot.promptContext).toContain(`"throughRevision": ${state.revision}`);
    } finally {
      db.close();
    }
  });

  it('uses the previous summary revision as the activity lower bound and reports truncation', () => {
    const db = makeDb();
    try {
      insertEvent(db, 'message', { role: 'assistant', text: 'old activity' }, 30);
      const oldRevision = createEventRevisionRepo(db).state('summary-evidence')!.revision;
      for (let index = 0; index < 130; index += 1) {
        insertEvent(db, 'file-changed', { filePath: `/repo/file-${index}.ts` }, 31 + index);
      }
      const snapshot = capturePeriodicSummaryEvidence(
        'summary-evidence',
        previous(oldRevision),
        db,
      )!;
      expect(snapshot.sourceEventRevision).toBeGreaterThan(oldRevision);
      expect(formatEventsForPrompt(snapshot.events)).not.toContain('old activity');
      expect(snapshot.events.length).toBeLessThanOrEqual(120);
      expect(snapshot.activityTruncated).toBe(true);
      expect(snapshot.promptContext).toContain('"activityTruncated": true');
    } finally {
      db.close();
    }
  });
});
