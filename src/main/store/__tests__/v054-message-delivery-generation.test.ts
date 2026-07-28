import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { createAgentDeckMessageRepo } from '../agent-deck-message-repo';
import { rowToRecord, type MessageRow } from '../agent-deck-message-repo/_deps';
import v054 from '../migrations/v054_message_delivery_generation.sql?raw';
import { bindingAvailable } from './_binding-probe';
import { insertSession, makeMemoryDb } from './agent-deck-repos/_setup';

describe.skipIf(!bindingAvailable)('v054 message delivery generation migration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeMemoryDb();
    db.pragma('user_version = 53');
    insertSession(db, 'source');
    insertSession(db, 'target');
  });

  afterEach(() => db.close());

  it('upgrades v053 data in place without changing messages, replies, or statuses', () => {
    const insert = db.prepare(
      `INSERT INTO agent_deck_messages
       (id, team_id, from_session_id, to_session_id, body, status, status_reason,
        sent_at, delivered_at, attempt_count, last_attempt_at, delivering_since,
        reply_to_message_id)
       VALUES (?, NULL, 'source', 'target', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('pending', 'pending', 'pending', null, 1, null, 0, null, null, null);
    insert.run('delivering', 'delivering', 'delivering', null, 2, null, 1, 2, 2, null);
    insert.run('delivered', 'delivered', 'delivered', null, 3, 4, 1, 3, null, 'pending');
    insert.run('failed', 'failed', 'failed', 'boom', 5, null, 3, 5, null, 'pending');
    insert.run('cancelled', 'cancelled', 'cancelled', 'cancelled', 6, null, 0, null, null, null);

    const before = db.prepare(
      `SELECT id, team_id, from_session_id, to_session_id, body, status, status_reason,
              sent_at, delivered_at, attempt_count, last_attempt_at, delivering_since,
              reply_to_message_id
         FROM agent_deck_messages
        ORDER BY rowid`,
    ).all();

    db.transaction(() => {
      db.exec(v054);
      db.pragma('user_version = 54');
    })();

    expect(db.pragma('user_version', { simple: true })).toBe(54);
    expect(db.prepare(
      `SELECT id, team_id, from_session_id, to_session_id, body, status, status_reason,
              sent_at, delivered_at, attempt_count, last_attempt_at, delivering_since,
              reply_to_message_id
         FROM agent_deck_messages
        ORDER BY rowid`,
    ).all()).toEqual(before);

    const upgraded = createAgentDeckMessageRepo(db).listBySession('source', { limit: 10 });
    expect(upgraded).toHaveLength(5);
    expect(upgraded.map((message) => message.status).sort()).toEqual(
      ['cancelled', 'delivered', 'delivering', 'failed', 'pending'],
    );
    expect(upgraded.every((message) => message.deliveryGeneration === 0)).toBe(true);
    expect(upgraded.every((message) => message.deliveryLeaseToSessionId === null)).toBe(true);
    expect(upgraded.find((message) => message.id === 'delivered')?.replyToMessageId)
      .toBe('pending');
  });
});

describe('v054 row compatibility', () => {
  it('maps a pre-v054 row fixture to a safe unclaimed generation', () => {
    const oldRow: MessageRow = {
      id: 'old-row',
      team_id: null,
      from_session_id: 'source',
      to_session_id: 'target',
      body: 'body',
      status: 'pending',
      status_reason: null,
      sent_at: 1,
      delivered_at: null,
      attempt_count: 0,
      last_attempt_at: null,
      delivering_since: null,
      reply_to_message_id: null,
    };

    expect(rowToRecord(oldRow)).toMatchObject({
      deliveryGeneration: 0,
      deliveryLeaseToSessionId: null,
    });
  });
});
