import Database from 'better-sqlite3';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SessionRecord } from '@shared/types';
import { vi } from 'vitest';

import { ServerCoreIssueRepository } from './issue-repository';
import type { ServerCoreMcpToolHost } from './mcp-tool-host';
import { ServerCoreSessionTaskReadRepository } from './session-task-read-repository';

const databases: Database.Database[] = [];
const roots: string[] = [];

export function mcpTestSession(
  id: string,
  cwd: string,
  lifecycle: SessionRecord['lifecycle'] = 'active',
) {
  return {
    id, agentId: 'codex-cli', cwd, title: id,
    source: 'sdk', lifecycle, activity: 'working',
    startedAt: 1, lastEventAt: 1, endedAt: null, archivedAt: null,
  } satisfies SessionRecord;
}

function schema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE agent_deck_teams (id TEXT PRIMARY KEY, archived_at INTEGER);
    CREATE TABLE agent_deck_team_members (
      team_id TEXT NOT NULL, session_id TEXT NOT NULL, left_at INTEGER, joined_at INTEGER NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, owner_session_id TEXT NOT NULL, team_id TEXT,
      subject TEXT NOT NULL, description TEXT, status TEXT NOT NULL, active_form TEXT,
      priority INTEGER NOT NULL, blocks TEXT NOT NULL, blocked_by TEXT NOT NULL,
      labels TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE issues (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, repro TEXT,
      kind TEXT NOT NULL, status TEXT NOT NULL, severity TEXT NOT NULL,
      source_session_id TEXT, cwd TEXT, branch_name TEXT, logs_ref TEXT,
      resolution_session_id TEXT, labels TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, resolved_at INTEGER, deleted_at INTEGER
    );
    CREATE TABLE issue_appendices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id TEXT NOT NULL, body TEXT NOT NULL,
      logs_ref TEXT, appended_session_id TEXT, appended_at INTEGER NOT NULL
    );
  `);
}

export function createMcpServerHarness() {
  const workspaceRoot = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'core-mcp-')));
  roots.push(workspaceRoot);
  const database = new Database(':memory:');
  databases.push(database);
  schema(database);
  database.exec(`
    INSERT INTO agent_deck_teams VALUES ('team-a', NULL);
    INSERT INTO agent_deck_team_members VALUES ('team-a', 'caller-a', NULL, 1);
  `);
  const records = new Map<string, SessionRecord>([
    ['caller-a', mcpTestSession('caller-a', workspaceRoot)],
    ['caller-b', mcpTestSession('caller-b', workspaceRoot)],
  ]);
  const changes: Array<{ kind: string; entityId: string | null }> = [];
  const spawn = vi.fn(async (_callerId: string, args: {
    adapter: 'claude-code' | 'codex-cli' | 'grok-build';
    cwd: string;
    displayName?: string;
    agentName?: string;
  }) => ({
    sessionId: 'spawned-a', adapter: args.adapter, gateway: null, provider: null, cwd: args.cwd,
    teamId: null, teamName: null, displayName: args.displayName ?? args.agentName ?? null,
    agentName: args.agentName ?? null, spawnDepth: 1,
    spawnLimits: {
      depth: { current: 0, next: 1, max: 3 },
      fanOut: { current: 1, activeChildren: 1, inFlight: 0, max: 10 },
      rate: { current: 1, max: 20, windowMs: 60_000, retryAfterMs: 0 },
    },
    sentAt: 1, spawnPromptMessageId: 'message-spawn',
  }));
  const handOff = vi.fn(async () => ({
    sessionId: 'successor-a', adapter: 'codex-cli' as const, gateway: null,
    provider: 'openai', cwd: 'project-a',
    continuationContext: {
      version: 2, quality: 'raw-only' as const, sourceEventRevision: 2, cutoverEventRevision: 2,
      rebuildAfterRevision: 0,
      checkpoint: { id: null, formatVersion: 1, throughRevision: 0, refreshed: false },
      preparationHash: 'a'.repeat(64),
      tokenStats: {
        rawRetentionCeiling: 64_000, targetPromptCapacity: 64_000,
        checkpointProjectionBudget: 0, generatorFoldInputBudget: 0,
        estimatedPrompt: 100, checkpoint: 0, rawTail: 50,
      },
      includedUserMessages: 1, lateMessagesDelivered: 0, usedLowerBudgetRetry: false,
      truncatedBoundaryMessages: 0, foldCalls: 0, repairCalls: 0, warningCodes: [],
    },
    callerClosed: 'ok' as const, warnings: [],
    resourceTransfer: {
      tasks: { status: 'ok' as const, count: 0 },
      teams: { status: 'ok' as const, transferred: [], skipped: [], failed: [] },
      worktreeLease: { status: 'skipped' as const, worktreePath: null },
    },
  }));
  const preview = vi.fn(async () => ({
    bindingDigest: `sha256:${'a'.repeat(64)}`,
    preview: 'continuation preview', previewTruncated: false, quality: 'raw-only' as const,
    source: { eventRevision: 2, rebuildAfterRevision: 0 },
    checkpoint: { id: null, throughRevision: 0, formatVersion: 1, refreshed: false },
    metrics: {
      estimatedPromptTokens: 100, checkpointTokens: 0, rawTailTokens: 50,
      includedUserMessages: 1, truncatedBoundaryMessages: 0,
      rawRetentionCeilingTokens: 64_000, elapsedMs: 1,
    },
    warnings: [], revision: 2,
    target: {
      adapterId: 'codex-cli' as const, workingDirectory: 'project-a',
      capabilityRevision: 'revision-a',
      options: {
        approvalPolicy: null, claudeCodeSandbox: null, codexSandbox: null,
        grokSandbox: null, model: null, permissionMode: null, provider: 'openai',
        sessionMode: null, thinking: null,
      },
    },
  }));
  const tasks = new ServerCoreSessionTaskReadRepository(() => database, { warn: vi.fn() });
  const issues = new ServerCoreIssueRepository(() => database, { warn: vi.fn() });
  const host: ServerCoreMcpToolHost = {
    workspaceRoot, privateRoots: [], sessions: { get: (id) => records.get(id) ?? null },
    tasks, issues,
    collaboration: {
      start: () => Promise.resolve(), stop: () => Promise.resolve(),
      drainForHandOff: () => Promise.resolve(true),
      list: (_callerId, args) => {
        const rows = [...records.values()].filter(
          (row) => row.lifecycle === (args.statusFilter ?? 'active'),
        );
        return { total: rows.length, hasMore: false, sessions: rows.map((row) => ({
          sessionId: row.id, adapter: row.agentId, gateway: null, provider: null, cwd: '.',
          lifecycle: row.lifecycle, title: row.title, lastEventAt: row.lastEventAt,
          teamName: null, teams: [], spawnedBy: row.spawnedBy ?? null,
          spawnDepth: row.spawnDepth ?? 0,
        })) };
      },
      get: (_callerId, id) => {
        const row = records.get(id);
        if (!row) throw new Error('missing');
        return {
          sessionId: row.id, adapter: row.agentId, gateway: null, provider: null, cwd: '.',
          lifecycle: row.lifecycle, title: row.title, lastEventAt: row.lastEventAt,
          teamName: null, teams: [], spawnedBy: row.spawnedBy ?? null,
          spawnDepth: row.spawnDepth ?? 0,
        };
      },
      listEvents: (_callerId, args) => ({
        sessionId: args.sessionId, hasMore: false, events: [],
      }),
      send: (_callerId, args) => ({
        sessionId: args.sessionId, teamId: args.teamId ?? null, messageId: 'message-a',
        replyToMessageId: args.replyToMessageId ?? null, sentAt: 1, queued: true,
      }),
      shutdown: async (_callerId, args) => ({
        sessionId: args.sessionId, lifecycle: 'closed', alreadyClosed: false,
      }),
    },
    spawn: { spawn }, handoff: { handOff, preview },
    worktree: {
      enter: vi.fn(async (_callerId, args) => ({
        transitionId: 'caller-a:1', direction: 'enter' as const,
        state: 'waiting-tool-result' as const, effectiveFrom: 'automatic-next-turn' as const,
        worktreePath: args.worktreePath ?? '.agent-deck/worktrees/generated',
        startCommit: 'a'.repeat(40), headMode: 'detached' as const,
      })),
      exit: vi.fn(async () => ({
        transitionId: 'caller-a:1', direction: 'exit' as const,
        state: 'waiting-tool-result' as const, effectiveFrom: 'automatic-next-turn' as const,
        worktreePath: '.agent-deck/worktrees/generated',
      })),
    },
    browser: {
      invoke: vi.fn(async () => ({
        content: [{ type: 'text' as const, text: '{"tabs":[]}' }],
      })),
    },
    presentations: {
      requestPlan: vi.fn(async () => ({ decision: 'approved' as const })),
      requestDiff: vi.fn(async () => ({ decision: 'approved' as const })),
    },
    teams: { activeTeamIds: (id) => tasks.activeTeamIds(id) },
    ownership: { isCurrentOwner: (historical, current) => historical === current },
    metadata: {
      appendChange: (kind, entityId) => {
        changes.push({ kind, entityId });
        return changes.length;
      },
    },
  };
  return { changes, handOff, host, issues, records, spawn, workspaceRoot };
}

export function cleanupMcpServerHarnesses(): void {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}
