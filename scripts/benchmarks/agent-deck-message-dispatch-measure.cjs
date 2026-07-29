#!/usr/bin/env node
'use strict';

const { fileSizes, nowMs } = require('./agent-deck-message-dispatch-fixture.cjs');

function percentile(sorted, ratio) {
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function stats(samples) {
  if (samples.length === 0) throw new Error('Cannot summarize empty samples');
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    n: samples.length,
    minMs: sorted[0],
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    maxMs: sorted.at(-1),
    meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    samplesMs: samples,
  };
}

function timed(call) {
  const started = nowMs();
  const value = call();
  return { elapsedMs: nowMs() - started, value };
}

function selectionResult(production, rows) {
  return {
    eligibleRows: rows.eligibleRows.length,
    excludingRows: rows.excludingRows.length,
    eligibleFingerprint: production.resultFingerprint(rows.eligibleRows),
    excludingFingerprint: production.resultFingerprint(rows.excludingRows),
  };
}

function runProductionReadTick(db, production, capture, input) {
  const tickStarted = nowMs();
  const eligible = timed(() => db.prepare(capture.eligibleSql).all(
    ...production.eligibleParams(capture, input.now, input.limit),
  ));
  if (eligible.value.length !== input.limit) {
    throw new Error('Benchmark fixture did not fill the production batch');
  }
  const counts = timed(() => eligible.value.map((row) =>
    db.prepare(capture.countSql).pluck().get(row.to_session_id)));
  const excluding = timed(() => db.prepare(capture.excludingSql).all(
    ...production.excludingParams(capture, input.now, input.excludeTargets),
  ));
  return {
    elapsedMs: nowMs() - tickStarted,
    eligibleMs: eligible.elapsedMs,
    countPendingMs: counts.elapsedMs,
    excludingMs: excluding.elapsedMs,
    rows: {
      eligibleRows: eligible.value,
      excludingRows: excluding.value,
    },
    countFingerprint: production.resultFingerprint(counts.value),
  };
}

function measureSelection({
  Database,
  db,
  dbPath,
  production,
  capture,
  input,
  repetitions,
  freshRepetitions,
}) {
  const first = runProductionReadTick(db, production, capture, input);
  const warmEligible = [];
  const warmExcluding = [];
  const warmCounts = [];
  const warmTicks = [];
  const eligibleFingerprints = new Set();
  const excludingFingerprints = new Set();
  const countFingerprints = new Set();
  for (let index = 0; index < repetitions; index += 1) {
    const tick = runProductionReadTick(db, production, capture, input);
    warmEligible.push(tick.eligibleMs);
    warmCounts.push(tick.countPendingMs);
    warmExcluding.push(tick.excludingMs);
    warmTicks.push(tick.elapsedMs);
    eligibleFingerprints.add(
      production.resultFingerprint(tick.rows.eligibleRows),
    );
    excludingFingerprints.add(
      production.resultFingerprint(tick.rows.excludingRows),
    );
    countFingerprints.add(tick.countFingerprint);
  }

  const freshOpen = [];
  const freshEligible = [];
  const freshCounts = [];
  const freshExcluding = [];
  const freshTicks = [];
  const freshClose = [];
  for (let index = 0; index < freshRepetitions; index += 1) {
    const opened = timed(() =>
      new Database(dbPath, { readonly: true, fileMustExist: true }));
    freshOpen.push(opened.elapsedMs);
    const connection = opened.value;
    const tick = runProductionReadTick(
      connection,
      production,
      capture,
      input,
    );
    freshEligible.push(tick.eligibleMs);
    freshCounts.push(tick.countPendingMs);
    freshExcluding.push(tick.excludingMs);
    freshTicks.push(tick.elapsedMs);
    const closed = timed(() => connection.close());
    freshClose.push(closed.elapsedMs);
  }

  const plans = production.explainProduction(db, capture, input);
  return {
    first: {
      tickMs: first.elapsedMs,
      eligibleMs: first.eligibleMs,
      countPendingMs: first.countPendingMs,
      excludingMs: first.excludingMs,
      ...selectionResult(production, first.rows),
    },
    warm: {
      eligible: stats(warmEligible),
      countPendingForBatch: stats(warmCounts),
      excluding: stats(warmExcluding),
      tickReadUpperBound: stats(warmTicks),
      observedFingerprints: {
        eligible: [...eligibleFingerprints].sort(),
        excluding: [...excludingFingerprints].sort(),
        counts: [...countFingerprints].sort(),
      },
    },
    freshConnection: {
      open: stats(freshOpen),
      eligible: stats(freshEligible),
      countPendingForBatch: stats(freshCounts),
      excluding: stats(freshExcluding),
      tickReadUpperBound: stats(freshTicks),
      close: stats(freshClose),
    },
    plans: {
      eligible: production.planDetails(plans.eligible),
      excluding: production.planDetails(plans.excluding),
      countPendingForTarget: production.planDetails(
        plans.countPendingForTarget,
      ),
    },
    result: {
      ...selectionResult(production, first.rows),
      countFingerprint: first.countFingerprint,
    },
    memory: process.memoryUsage(),
  };
}

function withRollback(db, name, call) {
  db.exec(`SAVEPOINT ${name}`);
  try {
    return call();
  } finally {
    db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
  }
}

function measureWrites({
  db,
  production,
  repoRoot,
  repetitions,
  phase,
}) {
  const repos = production.loadProductionMessageRepositories(repoRoot, db);
  const enqueueSamples = [];
  const claimSamples = [];
  const acknowledgeSamples = [];
  const retrySamples = [];
  const pending = db.prepare(
    `SELECT id, to_session_id AS toSessionId
       FROM agent_deck_messages
      WHERE status = 'pending' AND attempt_count = 0
      ORDER BY sent_at, rowid LIMIT 1`,
  ).get();
  if (!pending) throw new Error('Fixture has no pending retry benchmark row');

  for (let index = 0; index < repetitions; index += 1) {
    withRollback(db, `enqueue_${index}`, () => {
      const measured = timed(() => repos.crud.insert({
        id: `benchmark-${phase}-enqueue-${index}`,
        teamId: null,
        fromSessionId: 'sender-000',
        toSessionId: 'target-001',
        body: 'benchmark enqueue write amplification',
        replyToMessageId: null,
      }));
      enqueueSamples.push(measured.elapsedMs);
    });

    withRollback(db, `ack_${index}`, () => {
      const claimed = timed(() =>
        repos.stateMachine.claim(pending.id, 1_800_000_000_000 + index));
      if (!claimed.value) throw new Error('Production claim returned null');
      claimSamples.push(claimed.elapsedMs);
      const lease = {
        messageId: claimed.value.id,
        toSessionId: claimed.value.toSessionId,
        generation: claimed.value.deliveryGeneration,
      };
      const acknowledged = timed(() =>
        repos.stateMachine.markDelivered(
          lease,
          1_800_000_000_050 + index,
        ));
      if (!acknowledged.value) {
        throw new Error('Production acknowledgement returned null');
      }
      acknowledgeSamples.push(acknowledged.elapsedMs);
    });

    withRollback(db, `retry_${index}`, () => {
      const claimed = repos.stateMachine.claim(
        pending.id,
        1_800_000_000_000 + index,
      );
      if (!claimed) throw new Error('Production retry claim returned null');
      const lease = {
        messageId: claimed.id,
        toSessionId: claimed.toSessionId,
        generation: claimed.deliveryGeneration,
      };
      const retried = timed(() =>
        repos.stateMachine.retryAfterFail(
          lease,
          'benchmark retry',
          1_800_000_000_100 + index,
        ));
      if (!retried.value) throw new Error('Production retry returned null');
      retrySamples.push(retried.elapsedMs);
    });
  }
  return {
    phase,
    repetitions,
    enqueueInsertAndGet: stats(enqueueSamples),
    claim: stats(claimSamples),
    acknowledgeUpdateAndGet: stats(acknowledgeSamples),
    retrySelectUpdateAndGet: stats(retrySamples),
    sourceHashes: repos.sourceHashes,
  };
}

function installV56({ db, dbPath, migration }) {
  const checkpointBefore = timed(() =>
    db.pragma('wal_checkpoint(TRUNCATE)'));
  const before = fileSizes(dbPath);
  const memoryBefore = process.memoryUsage();
  const build = timed(() => {
    db.transaction(() => {
      db.exec(migration.sql);
      db.pragma('user_version = 56');
    }).immediate();
  });
  const checkpoint = timed(() => db.pragma('wal_checkpoint(TRUNCATE)'));
  const after = fileSizes(dbPath);
  return {
    checkpointBeforeMs: checkpointBefore.elapsedMs,
    buildMs: build.elapsedMs,
    checkpointMs: checkpoint.elapsedMs,
    filesBefore: before,
    filesAfter: after,
    sizeDeltaBytes: after.db - before.db,
    memoryBefore,
    memoryAfter: process.memoryUsage(),
  };
}

module.exports = {
  installV56,
  measureSelection,
  measureWrites,
  stats,
};
