import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { SessionRecord } from '@shared/types';
import { createEventRevisionRepo } from '@main/store/event-revision-repo';
import {
  bindingAvailable,
  insertSession,
  makeMemoryDb,
} from '@main/store/__tests__/agent-deck-repos/_setup';
import { continuationSessionRuntimeFingerprint } from '../../continuation-context/source-spool';
import {
  assessHandOffSourceEvents,
  checkHandOffSourcePrecondition,
  type HandOffSourceCutoverPrecondition,
  type HandOffSourcePreconditionDeps,
} from '../source-precondition';

const SOURCE_ID = 'handoff-source';

function insertEvent(
  db: Database.Database,
  kind: string,
  payload: Record<string, unknown>,
): number {
  const toolUseId =
    (kind === 'tool-use-start' || kind === 'tool-use-end') &&
    typeof payload.toolUseId === 'string' &&
    payload.toolUseId.length > 0
      ? payload.toolUseId
      : null;
  const info = db
    .prepare(
      `INSERT INTO events (session_id, kind, payload_json, ts, tool_use_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(SOURCE_ID, kind, JSON.stringify(payload), Date.now(), toolUseId);
  return Number(info.lastInsertRowid);
}

function sourceRecord(db: Database.Database): SessionRecord | null {
  const row = db
    .prepare(`SELECT lifecycle, archived_at FROM sessions WHERE id = ?`)
    .get(SOURCE_ID) as { lifecycle: SessionRecord['lifecycle']; archived_at: number | null } | undefined;
  if (!row) return null;
  return {
    id: SOURCE_ID,
    agentId: 'codex-cli',
    cwd: '/tmp',
    title: 'handoff source',
    source: 'sdk',
    lifecycle: row.lifecycle,
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: row.archived_at,
  };
}

describe.skipIf(!bindingAvailable)('handoff source append-only cutover policy', () => {
  let db: Database.Database;
  let deps: HandOffSourcePreconditionDeps;
  let boundary: HandOffSourceCutoverPrecondition;
  let capturedEventId: number;

  beforeEach(() => {
    db = makeMemoryDb();
    insertSession(db, SOURCE_ID, 'codex-cli');
    capturedEventId = insertEvent(db, 'message', {
      role: 'assistant',
      text: 'captured assistant state',
    });
    const reader = createEventRevisionRepo(db);
    const state = reader.state(SOURCE_ID)!;
    boundary = {
      eventRevision: state.revision,
      rebuildAfterRevision: state.rebuildAfterRevision,
      maxEventId: capturedEventId,
      runtimeFingerprint: continuationSessionRuntimeFingerprint(db, SOURCE_ID)!,
    };
    deps = {
      getSession: () => sourceRecord(db),
      runtimeFingerprint: () => continuationSessionRuntimeFingerprint(db, SOURCE_ID),
      eventReader: reader,
    };
  });

  afterEach(() => db.close());

  it.each([
    ['thinking', { text: 'progress reasoning' }],
    ['message', { role: 'assistant', text: 'handoff is still running' }],
    ['tool-use-start', { toolName: 'status', toolUseId: 'late-tool' }],
  ])('allows appended non-user %s activity', (kind, payload) => {
    insertEvent(db, kind, payload);

    expect(
      checkHandOffSourcePrecondition(
        { sourceSessionId: SOURCE_ID, expected: boundary },
        deps,
      ),
    ).toMatchObject({
      ok: true,
      compatibleEventRows: 1,
      lateMessages: [],
    });
  });

  it.each([
    ['user', 'continue with the corrected requirement', 'user'],
    [
      'cross-session',
      '[from Reviewer @ codex-cli][msg 123e4567-e89b-12d3-a456-426614174000][sid 019f5718-1111-2222-3333-abcdefabcdef]\nreply',
      'cross-session',
    ],
  ] as const)('retains appended %s input for successor delivery', (_kind, text, origin) => {
    const eventId = insertEvent(db, 'message', { role: 'user', text });

    expect(
      checkHandOffSourcePrecondition(
        { sourceSessionId: SOURCE_ID, expected: boundary },
        deps,
      ),
    ).toMatchObject({
      ok: true,
      currentEventRevision: boundary.eventRevision + 1,
      compatibleEventRows: 1,
      lateMessages: [{ eventId, text, attachments: [], origin }],
    });
  });

  it('retains validated uploaded attachment refs on a late input', () => {
    const attachment = {
      kind: 'uploaded' as const,
      path: '/tmp/image-uploads/source.png',
      mime: 'image/png',
      bytes: 123,
    };
    const eventId = insertEvent(db, 'message', {
      role: 'user',
      text: 'look at this',
      attachments: [attachment],
    });

    expect(
      checkHandOffSourcePrecondition(
        { sourceSessionId: SOURCE_ID, expected: boundary },
        deps,
      ),
    ).toMatchObject({
      ok: true,
      lateMessages: [{ eventId, text: 'look at this', attachments: [attachment] }],
    });
  });

  it('rejects malformed late attachment refs instead of forwarding untrusted paths', () => {
    insertEvent(db, 'message', {
      role: 'user',
      text: 'broken attachment',
      attachments: [{ kind: 'uploaded', path: '../../etc/passwd' }],
    });

    expect(
      checkHandOffSourcePrecondition(
        { sourceSessionId: SOURCE_ID, expected: boundary },
        deps,
      ),
    ).toMatchObject({ ok: false, reason: 'late-attachment-invalid' });
  });

  it('rejects a business update to an event inside the captured boundary', () => {
    db.prepare(`UPDATE events SET payload_json = ? WHERE id = ?`).run(
      JSON.stringify({ role: 'assistant', text: 'rewritten captured state' }),
      capturedEventId,
    );

    expect(
      checkHandOffSourcePrecondition(
        { sourceSessionId: SOURCE_ID, expected: boundary },
        deps,
      ),
    ).toMatchObject({ ok: false, reason: 'captured-event-mutated' });
  });

  it.each(['tool-use-start', 'tool-use-end'] as const)(
    'allows an identity-preserving captured %s merge update',
    (kind) => {
      const toolEventId = insertEvent(db, kind, {
        toolUseId: `${kind}-id`,
        status: 'running',
      });
      const state = deps.eventReader.state(SOURCE_ID)!;
      const toolBoundary = {
        ...boundary,
        eventRevision: state.revision,
        maxEventId: toolEventId,
      };
      db.prepare(`UPDATE events SET payload_json = ?, ts = ? WHERE id = ?`).run(
        JSON.stringify({ toolUseId: `${kind}-id`, status: 'complete' }),
        Date.now() + 1,
        toolEventId,
      );

      expect(
        checkHandOffSourcePrecondition(
          { sourceSessionId: SOURCE_ID, expected: toolBoundary },
          deps,
        ),
      ).toMatchObject({ ok: true, compatibleEventRows: 1, lateMessages: [] });
    },
  );

  it('rejects a captured tool-shaped row update without a stable tool identity', () => {
    const toolEventId = insertEvent(db, 'tool-use-start', { status: 'running' });
    const state = deps.eventReader.state(SOURCE_ID)!;
    const toolBoundary = {
      ...boundary,
      eventRevision: state.revision,
      maxEventId: toolEventId,
    };
    db.prepare(`UPDATE events SET payload_json = ? WHERE id = ?`).run(
      JSON.stringify({ status: 'complete' }),
      toolEventId,
    );

    expect(
      checkHandOffSourcePrecondition(
        { sourceSessionId: SOURCE_ID, expected: toolBoundary },
        deps,
      ),
    ).toMatchObject({ ok: false, reason: 'captured-event-mutated' });
  });

  it('scans beyond one page and retains a user input from the second page', () => {
    for (let index = 0; index < 1_000; index += 1) {
      insertEvent(db, 'thinking', { text: `progress-${index}` });
    }
    const eventId = insertEvent(db, 'message', { role: 'user', text: 'page-two input' });

    expect(
      checkHandOffSourcePrecondition(
        { sourceSessionId: SOURCE_ID, expected: boundary },
        deps,
      ),
    ).toMatchObject({
      ok: true,
      compatibleEventRows: 1_001,
      lateMessages: [{ eventId, text: 'page-two input' }],
    });
  });

  it('accepts an appended legacy row whose change_revision is null', () => {
    const eventId = insertEvent(db, 'message', { role: 'assistant', text: 'legacy append' });
    db.prepare(`UPDATE events SET change_revision = NULL WHERE id = ?`).run(eventId);

    expect(
      checkHandOffSourcePrecondition(
        { sourceSessionId: SOURCE_ID, expected: boundary },
        deps,
      ),
    ).toMatchObject({ ok: true, compatibleEventRows: 1 });
  });

  it('supports a capture boundary with no existing event ids', () => {
    const emptyId = 'empty-handoff-source';
    insertSession(db, emptyId, 'codex-cli');
    const state = deps.eventReader.state(emptyId)!;
    const emptyBoundary = {
      eventRevision: state.revision,
      rebuildAfterRevision: state.rebuildAfterRevision,
      maxEventId: null,
      runtimeFingerprint: continuationSessionRuntimeFingerprint(db, emptyId)!,
    };
    const emptyDeps: HandOffSourcePreconditionDeps = {
      getSession: () => ({ ...sourceRecord(db)!, id: emptyId }),
      runtimeFingerprint: () => continuationSessionRuntimeFingerprint(db, emptyId),
      eventReader: deps.eventReader,
    };

    expect(
      checkHandOffSourcePrecondition(
        { sourceSessionId: emptyId, expected: emptyBoundary },
        emptyDeps,
      ),
    ).toEqual({
      ok: true,
      currentEventRevision: 0,
      compatibleEventRows: 0,
      lateMessages: [],
    });
  });

  it('restarts a mixed scan until the revision snapshot is stable', () => {
    const states = [
      { sessionId: SOURCE_ID, revision: 2, rebuildAfterRevision: 0 },
      { sessionId: SOURCE_ID, revision: 3, rebuildAfterRevision: 0 },
      { sessionId: SOURCE_ID, revision: 3, rebuildAfterRevision: 0 },
      { sessionId: SOURCE_ID, revision: 3, rebuildAfterRevision: 0 },
    ];
    let stateIndex = 0;
    const reader = {
      state: () => states[Math.min(stateIndex++, states.length - 1)],
      listRawEvents: ({ throughRevision }: { throughRevision: number }) => [
        {
          id: 2,
          sessionId: SOURCE_ID,
          effectiveRevision: 2,
          kind: 'thinking',
          payloadJson: '{}',
          ts: 2,
          toolUseId: null,
        },
        ...(throughRevision >= 3
          ? [{
              id: 3,
              sessionId: SOURCE_ID,
              effectiveRevision: 3,
              kind: 'message',
              payloadJson: JSON.stringify({ role: 'user', text: 'arrived mid-scan' }),
              ts: 3,
              toolUseId: null,
            }]
          : []),
      ],
    };

    expect(
      assessHandOffSourceEvents(
        {
          sourceSessionId: SOURCE_ID,
          expected: { ...boundary, eventRevision: 1, maxEventId: 1 },
        },
        reader,
      ),
    ).toMatchObject({
      ok: true,
      currentEventRevision: 3,
      compatibleEventRows: 2,
      lateMessages: [{ eventId: 3, text: 'arrived mid-scan' }],
    });
  });

  it('fails with source-kept-changing after the bounded stability retries', () => {
    let revision = 2;
    const reader = {
      state: () => ({
        sessionId: SOURCE_ID,
        revision: revision++,
        rebuildAfterRevision: 0,
      }),
      listRawEvents: ({ throughRevision }: { throughRevision: number }) => [{
        id: throughRevision,
        sessionId: SOURCE_ID,
        effectiveRevision: throughRevision,
        kind: 'thinking',
        payloadJson: '{}',
        ts: throughRevision,
        toolUseId: null,
      }],
    };

    expect(
      assessHandOffSourceEvents(
        {
          sourceSessionId: SOURCE_ID,
          expected: { ...boundary, eventRevision: 1, maxEventId: 1 },
        },
        reader,
      ),
    ).toEqual({ ok: false, reason: 'source-kept-changing', currentEventRevision: 7 });
  });

  it('rejects deletion after capture', () => {
    db.prepare(`DELETE FROM events WHERE id = ?`).run(capturedEventId);
    expect(
      checkHandOffSourcePrecondition(
        { sourceSessionId: SOURCE_ID, expected: boundary },
        deps,
      ),
    ).toMatchObject({ ok: false, reason: 'rebuild-epoch-changed' });
  });

  it('rejects runtime drift after capture', () => {
    db.prepare(`UPDATE sessions SET model = 'changed-model' WHERE id = ?`).run(SOURCE_ID);
    expect(
      checkHandOffSourcePrecondition(
        { sourceSessionId: SOURCE_ID, expected: boundary },
        deps,
      ),
    ).toMatchObject({ ok: false, reason: 'runtime-changed' });
  });

  it.each(['closed', 'archived'] as const)('rejects a %s source', (kind) => {
    if (kind === 'closed') {
      db.prepare(`UPDATE sessions SET lifecycle = 'closed' WHERE id = ?`).run(SOURCE_ID);
    } else {
      db.prepare(`UPDATE sessions SET archived_at = 1 WHERE id = ?`).run(SOURCE_ID);
    }
    expect(
      checkHandOffSourcePrecondition(
        { sourceSessionId: SOURCE_ID, expected: boundary },
        deps,
      ),
    ).toMatchObject({ ok: false, reason: 'source-not-open' });
  });

  it('fails closed on revision regression or an unexplained revision gap', () => {
    db.prepare(
      `UPDATE session_event_revisions SET revision = ? WHERE session_id = ?`,
    ).run(boundary.eventRevision - 1, SOURCE_ID);
    expect(
      checkHandOffSourcePrecondition(
        { sourceSessionId: SOURCE_ID, expected: boundary },
        deps,
      ),
    ).toMatchObject({ ok: false, reason: 'revision-regressed' });

    db.prepare(
      `UPDATE session_event_revisions SET revision = ? WHERE session_id = ?`,
    ).run(boundary.eventRevision + 1, SOURCE_ID);
    expect(
      checkHandOffSourcePrecondition(
        { sourceSessionId: SOURCE_ID, expected: boundary },
        deps,
      ),
    ).toMatchObject({ ok: false, reason: 'revision-gap' });
  });
});
