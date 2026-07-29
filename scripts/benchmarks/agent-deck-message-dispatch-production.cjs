#!/usr/bin/env node
'use strict';

const { createHash } = require('node:crypto');
const { readFileSync, realpathSync } = require('node:fs');
const { createRequire } = require('node:module');
const { join, resolve } = require('node:path');
const vm = require('node:vm');

const CRUD_PATH = 'src/main/store/agent-deck-message-repo/crud.ts';
const DISPATCH_PATH = 'src/main/store/agent-deck-message-repo/dispatch.ts';
const DELIVERY_STATE_PATH = 'src/main/store/message-delivery-state.ts';
const MIGRATION_REGISTRY_PATH = 'src/main/store/migrations/index.ts';
const STATE_MACHINE_PATH = 'src/main/store/agent-deck-message-repo/state-machine.ts';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function loadTypeScriptModule({
  projectRequire,
  repoRoot,
  relativePath,
  resolveDependency,
}) {
  const ts = projectRequire('typescript');
  const sourcePath = join(repoRoot, relativePath);
  const source = readFileSync(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
  }).outputText;
  const record = { exports: {} };
  const wrapper = vm.runInThisContext(
    `(function(require, module, exports) { ${output}\n})`,
    { filename: `${sourcePath}.dispatch-benchmark.cjs` },
  );
  wrapper(resolveDependency, record, record.exports);
  return { exports: record.exports, source };
}

function projectContext(repoInput) {
  const repoRoot = realpathSync(resolve(repoInput));
  const projectRequire = createRequire(join(repoRoot, 'package.json'));
  const logger = {
    scope: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
    }),
  };
  return { logger, projectRequire, repoRoot };
}

function loadDeliveryState(context) {
  const { logger, projectRequire, repoRoot } = context;
  return loadTypeScriptModule({
    projectRequire,
    repoRoot,
    relativePath: DELIVERY_STATE_PATH,
    resolveDependency(specifier) {
      if (specifier === '@shared/message-limits') {
        return { MAX_USER_MESSAGE_LENGTH: 102_400 };
      }
      if (specifier === '@main/utils/logger') {
        return { __esModule: true, default: logger };
      }
      throw new Error(`Unexpected delivery-state dependency: ${specifier}`);
    },
  });
}

function captureProductionDispatch(repoInput, excludeTargets = ['benchmark-excluded-target']) {
  if (!Array.isArray(excludeTargets) || excludeTargets.length === 0) {
    throw new Error('At least one exclusion target is required');
  }
  const context = projectContext(repoInput);
  const { projectRequire, repoRoot } = context;
  const state = loadDeliveryState(context);

  const calls = [];
  const fakeDb = {
    prepare(sql) {
      return {
        all(...params) {
          calls.push({ sql, params });
          return [];
        },
        get(...params) {
          calls.push({ sql, params });
          return { c: 0 };
        },
      };
    },
  };
  const dispatch = loadTypeScriptModule({
    projectRequire,
    repoRoot,
    relativePath: DISPATCH_PATH,
    resolveDependency(specifier) {
      if (specifier === '@main/store/message-delivery-state') {
        return state.exports;
      }
      if (specifier === './_deps') {
        return { rowToRecord: (row) => row };
      }
      throw new Error(`Unexpected dispatch dependency: ${specifier}`);
    },
  });

  const repo = dispatch.exports.createDispatch(fakeDb);
  repo.findEligible({ now: 12_345, limit: 16 });
  repo.findEligibleExcludingTargets({
    now: 12_345,
    excludeTargets,
  });
  repo.countPendingForTarget('benchmark-count-target');
  if (calls.length !== 3) {
    throw new Error(`Expected three captured production queries, got ${calls.length}`);
  }
  const eligible = calls[0];
  const excluding = calls[1];
  const count = calls[2];
  const backoffPlaceholderCount = eligible.params.length - 1;
  if (
    backoffPlaceholderCount <= 0 ||
    excluding.params.length - excludeTargets.length !== backoffPlaceholderCount
  ) {
    throw new Error('Production dispatch placeholder contract changed');
  }
  return {
    repoRoot,
    eligibleSql: eligible.sql,
    excludingSql: excluding.sql,
    countSql: count.sql,
    backoffPlaceholderCount,
    sqlHashes: {
      eligible: sha256(eligible.sql),
      excluding: sha256(excluding.sql),
      countPendingForTarget: sha256(count.sql),
    },
    sourceHashes: {
      [DISPATCH_PATH]: sha256(dispatch.source),
      [DELIVERY_STATE_PATH]: sha256(state.source),
    },
  };
}

function rowToRecord(row) {
  return {
    id: row.id,
    teamId: row.team_id,
    fromSessionId: row.from_session_id,
    toSessionId: row.to_session_id,
    body: row.body,
    status: row.status,
    statusReason: row.status_reason,
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at,
    deliveringSince: row.delivering_since,
    replyToMessageId: row.reply_to_message_id,
    deliveryGeneration: row.delivery_generation ?? 0,
    deliveryLeaseToSessionId: row.delivery_lease_to_session_id ?? null,
  };
}

function loadProductionMessageRepositories(repoInput, db) {
  const context = projectContext(repoInput);
  const { projectRequire, repoRoot } = context;
  const state = loadDeliveryState(context);
  const deps = {
    getById(database, messageId) {
      const row = database.prepare(
        'SELECT * FROM agent_deck_messages WHERE id = ?',
      ).get(messageId);
      return row ? rowToRecord(row) : null;
    },
    rowToRecord,
  };
  const resolveDependency = (specifier) => {
    if (specifier === '@main/store/message-delivery-state') {
      return state.exports;
    }
    if (specifier === './_deps') return deps;
    throw new Error(`Unexpected message repository dependency: ${specifier}`);
  };
  const crud = loadTypeScriptModule({
    projectRequire,
    repoRoot,
    relativePath: CRUD_PATH,
    resolveDependency,
  });
  const stateMachine = loadTypeScriptModule({
    projectRequire,
    repoRoot,
    relativePath: STATE_MACHINE_PATH,
    resolveDependency,
  });
  return {
    crud: crud.exports.createCrud(db),
    stateMachine: stateMachine.exports.createStateMachine(db),
    sourceHashes: {
      [CRUD_PATH]: sha256(crud.source),
      [STATE_MACHINE_PATH]: sha256(stateMachine.source),
    },
  };
}

function captureMigrationInventory(repoInput) {
  const { repoRoot } = projectContext(repoInput);
  const registry = readFileSync(join(repoRoot, MIGRATION_REGISTRY_PATH), 'utf8');
  const imports = [...registry.matchAll(
    /import v(\d{3}) from '\.\/(v\d{3}_[^']+\.sql)\?raw';/g,
  )].map((match) => ({
    version: Number(match[1]),
    path: `src/main/store/migrations/${match[2]}`,
  }));
  if (imports.length === 0) throw new Error('Migration registry capture failed');
  for (let index = 0; index < imports.length; index += 1) {
    if (imports[index].version !== index + 1) {
      throw new Error(`Migration registry is not contiguous at ${index + 1}`);
    }
  }
  const migrations = imports.map((entry) => {
    const sql = readFileSync(join(repoRoot, entry.path), 'utf8');
    return { ...entry, sql, sha256: sha256(sql) };
  });
  return {
    latestVersion: migrations.at(-1).version,
    migrations,
    sourceHashes: {
      [MIGRATION_REGISTRY_PATH]: sha256(registry),
      ...Object.fromEntries(migrations.map((migration) => [
        migration.path,
        migration.sha256,
      ])),
    },
    throughV55SqlSha256: sha256(
      migrations
        .filter(({ version }) => version <= 55)
        .map(({ sql }) => sql)
        .join('\n'),
    ),
  };
}

function eligibleParams(capture, now, limit = 16) {
  return [
    ...Array.from({ length: capture.backoffPlaceholderCount }, () => now),
    limit,
  ];
}

function excludingParams(capture, now, excludeTargets) {
  return [
    ...Array.from({ length: capture.backoffPlaceholderCount }, () => now),
    ...excludeTargets,
  ];
}

function selectProductionRows(db, capture, {
  now,
  limit = 16,
  excludeTargets,
}) {
  const eligibleRows = db.prepare(capture.eligibleSql).all(
    ...eligibleParams(capture, now, limit),
  );
  const excludingRows = db.prepare(capture.excludingSql).all(
    ...excludingParams(capture, now, excludeTargets),
  );
  return { eligibleRows, excludingRows };
}

function explainProduction(db, capture, {
  now,
  limit = 16,
  excludeTargets,
}) {
  return {
    eligible: db.prepare(`EXPLAIN QUERY PLAN ${capture.eligibleSql}`).all(
      ...eligibleParams(capture, now, limit),
    ),
    excluding: db.prepare(`EXPLAIN QUERY PLAN ${capture.excludingSql}`).all(
      ...excludingParams(capture, now, excludeTargets),
    ),
    countPendingForTarget: db.prepare(
      `EXPLAIN QUERY PLAN ${capture.countSql}`,
    ).all(excludeTargets[0]),
  };
}

function resultFingerprint(rows) {
  return sha256(JSON.stringify(rows));
}

function planDetails(plan) {
  return plan.map((row) => String(row.detail));
}

module.exports = {
  captureMigrationInventory,
  captureProductionDispatch,
  eligibleParams,
  excludingParams,
  explainProduction,
  loadProductionMessageRepositories,
  planDetails,
  resultFingerprint,
  selectProductionRows,
  sha256,
};
