#!/usr/bin/env node
'use strict';

const { existsSync, statSync } = require('node:fs');

const FIXTURE_NOW = 1_800_000_000_000;
const DAY_MS = 86_400_000;

function nowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

function fileBytes(path) {
  return existsSync(path) ? statSync(path).size : 0;
}

function fileSizes(dbPath) {
  return {
    db: fileBytes(dbPath),
    wal: fileBytes(`${dbPath}-wal`),
    shm: fileBytes(`${dbPath}-shm`),
  };
}

function insertMetadata(db) {
  const insertSession = db.prepare(
    `INSERT INTO sessions
       (id, agent_id, cwd, title, source, lifecycle, activity,
        started_at, last_event_at)
     VALUES (?, ?, '/benchmark', ?, 'sdk', 'active', 'idle', 1, 1)`,
  );
  const insertTeam = db.prepare(
    `INSERT INTO agent_deck_teams
       (id, name, created_at, archived_at, metadata)
     VALUES (?, ?, 1, NULL, '{}')`,
  );
  const insertMember = db.prepare(
    `INSERT INTO agent_deck_team_members
       (team_id, session_id, role, display_name, joined_at, left_at)
     VALUES (?, ?, ?, ?, 1, NULL)`,
  );
  db.transaction(() => {
    for (let index = 0; index < 64; index += 1) {
      insertSession.run(
        `sender-${String(index).padStart(3, '0')}`,
        index % 3 === 0 ? 'claude-code' : index % 3 === 1 ? 'codex-cli' : 'grok-build',
        `sender ${index}`,
      );
    }
    for (let index = 0; index < 257; index += 1) {
      insertSession.run(
        `target-${String(index).padStart(3, '0')}`,
        index % 3 === 0 ? 'codex-cli' : index % 3 === 1 ? 'claude-code' : 'grok-build',
        `target ${index}`,
      );
    }
    for (let index = 0; index < 32; index += 1) {
      const teamId = `team-${String(index).padStart(2, '0')}`;
      insertTeam.run(teamId, `benchmark team ${index}`);
      for (let member = 0; member < 12; member += 1) {
        const target = `target-${String((index * 12 + member) % 257).padStart(3, '0')}`;
        insertMember.run(
          teamId,
          target,
          member === 0 ? 'lead' : 'teammate',
          `member-${index}-${member}`,
        );
      }
    }
    insertMember.run('team-00', 'sender-000', 'teammate', 'sender');
  })();
}

function statusFor(index, hotPrefix) {
  if (index < hotPrefix) return 'pending';
  const bucket = index % 100;
  if (bucket < 46) return 'pending';
  if (bucket < 56) return 'delivering';
  if (bucket < 80) return 'delivered';
  if (bucket < 90) return 'failed';
  return 'cancelled';
}

function pendingAttempt(index) {
  switch (index % 10) {
    case 5:
      return { attempt: 1, lastAttempt: FIXTURE_NOW - 2_000 };
    case 6:
      return { attempt: 1, lastAttempt: FIXTURE_NOW };
    case 7:
      return { attempt: 2, lastAttempt: FIXTURE_NOW - 5_000 };
    case 8:
      return { attempt: 2, lastAttempt: FIXTURE_NOW };
    case 9:
      return { attempt: 0, lastAttempt: FIXTURE_NOW };
    default:
      return { attempt: 0, lastAttempt: null };
  }
}

function messageFixture(index, hotPrefix, rowCount) {
  const status = statusFor(index, hotPrefix);
  const teamless = index % 10 < 3;
  const targetNumber = index < hotPrefix ? 0 : (index * 17) % 257;
  const target = `target-${String(targetNumber).padStart(3, '0')}`;
  const attempt = status === 'pending'
    ? pendingAttempt(index)
    : { attempt: status === 'failed' ? 3 : index % 3, lastAttempt: FIXTURE_NOW - 10_000 };
  const tieGroup = Math.floor(index / 4);
  const tieGroups = Math.max(1, Math.ceil(rowCount / 4));
  const sentAt = FIXTURE_NOW - 40 * DAY_MS +
    Math.floor(tieGroup * (40 * DAY_MS - 1) / tieGroups);
  return {
    id: `message-${String(index).padStart(9, '0')}`,
    teamId: teamless ? null : `team-${String(index % 32).padStart(2, '0')}`,
    sender: `sender-${String((index * 7) % 64).padStart(3, '0')}`,
    target,
    body: `dispatch-${String(index).padStart(9, '0')}-${'x'.repeat(77)}`,
    status,
    reason: status === 'failed' ? 'retry-exhausted' :
      status === 'cancelled' ? 'cancelled-fixture' : null,
    sentAt,
    deliveredAt: status === 'delivered' ? sentAt + 5_000 : null,
    attempt: attempt.attempt,
    lastAttempt: attempt.lastAttempt,
    deliveringSince: status === 'delivering' ? FIXTURE_NOW - 1_000 : null,
    replyTo: index > 0 && index % 20 === 0
      ? `message-${String(index - 1).padStart(9, '0')}`
      : null,
    generation: index % 5,
    lease: status === 'delivering' ? target : null,
  };
}

function insertMessages(db, rowCount) {
  const hotPrefix = Math.max(16, Math.floor(rowCount / 100));
  const insert = db.prepare(
    `INSERT INTO agent_deck_messages
       (id, team_id, from_session_id, to_session_id, body, status,
        status_reason, sent_at, delivered_at, attempt_count, last_attempt_at,
        delivering_since, reply_to_message_id, delivery_generation,
        delivery_lease_to_session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (let index = 0; index < rowCount; index += 1) {
      const row = messageFixture(index, hotPrefix, rowCount);
      insert.run(
        row.id,
        row.teamId,
        row.sender,
        row.target,
        row.body,
        row.status,
        row.reason,
        row.sentAt,
        row.deliveredAt,
        row.attempt,
        row.lastAttempt,
        row.deliveringSince,
        row.replyTo,
        row.generation,
        row.lease,
      );
      if (index > 0 && index % 500_000 === 0) {
        process.stderr.write(
          `[message-dispatch-bench] inserted ${index}/${rowCount}\n`,
        );
      }
    }
  })();
  return hotPrefix;
}

function readDistribution(db) {
  return {
    statuses: db.prepare(
      `SELECT status, COUNT(*) AS rows,
              SUM(team_id IS NULL) AS teamlessRows,
              COUNT(DISTINCT to_session_id) AS targets
         FROM agent_deck_messages
        GROUP BY status ORDER BY status`,
    ).all(),
    teamModes: db.prepare(
      `SELECT CASE WHEN team_id IS NULL THEN 'teamless' ELSE 'team' END AS mode,
              COUNT(*) AS rows
         FROM agent_deck_messages GROUP BY mode ORDER BY mode`,
    ).all(),
    pendingAttempts: db.prepare(
      `SELECT attempt_count AS attemptCount, COUNT(*) AS rows,
              SUM(last_attempt_at IS NULL) AS nullLastAttemptRows
         FROM agent_deck_messages
        WHERE status = 'pending'
        GROUP BY attempt_count ORDER BY attempt_count`,
    ).all(),
    distinct: db.prepare(
      `SELECT COUNT(DISTINCT from_session_id) AS senders,
              COUNT(DISTINCT to_session_id) AS targets,
              COUNT(DISTINCT sent_at) AS sentAtValues,
              SUM(reply_to_message_id IS NOT NULL) AS replies
         FROM agent_deck_messages`,
    ).get(),
  };
}

function buildFixture({ Database, dbPath, rowCount, migrations }) {
  const started = nowMs();
  const memoryBefore = process.memoryUsage();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('trusted_schema = ON');

  const migrationStarted = nowMs();
  for (const migration of migrations) {
    if (migration.version > 55) break;
    db.exec(migration.sql);
    db.pragma(`user_version = ${migration.version}`);
  }
  const migrationMs = nowMs() - migrationStarted;

  const metadataStarted = nowMs();
  insertMetadata(db);
  const metadataMs = nowMs() - metadataStarted;

  const messagesStarted = nowMs();
  const hotPrefix = insertMessages(db, rowCount);
  const messageInsertMs = nowMs() - messagesStarted;

  const checkpointStarted = nowMs();
  db.pragma('wal_checkpoint(TRUNCATE)');
  const checkpointMs = nowMs() - checkpointStarted;
  const distributionStarted = nowMs();
  const distribution = readDistribution(db);
  const distributionMs = nowMs() - distributionStarted;
  const sizes = fileSizes(dbPath);
  const pragmas = {
    userVersion: db.pragma('user_version', { simple: true }),
    journalMode: db.pragma('journal_mode', { simple: true }),
    synchronous: db.pragma('synchronous', { simple: true }),
    pageSize: db.pragma('page_size', { simple: true }),
    pageCount: db.pragma('page_count', { simple: true }),
    cacheSize: db.pragma('cache_size', { simple: true }),
    mmapSize: db.pragma('mmap_size', { simple: true }),
  };
  return {
    db,
    setup: {
      migrationMs,
      metadataMs,
      messageInsertMs,
      checkpointMs,
      distributionMs,
      totalMs: nowMs() - started,
      sizes,
      memoryBefore,
      memoryAfter: process.memoryUsage(),
      fixture: {
        rows: rowCount,
        hotPrefix,
        teams: 32,
        senders: 64,
        targets: 257,
        memberships: 385,
        sentAtTieWidth: 4,
        daySpan: 40,
        bodyCharacters: 96,
        fixtureNow: FIXTURE_NOW,
      },
      distribution,
      pragmas,
    },
  };
}

module.exports = {
  FIXTURE_NOW,
  buildFixture,
  fileSizes,
  nowMs,
};
