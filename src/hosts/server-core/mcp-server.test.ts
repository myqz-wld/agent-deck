import Database from 'better-sqlite3';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SessionRecord } from '@shared/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServerCoreIssueRepository } from './issue-repository';
import { createServerCoreMcpServer } from './mcp-server';
import { payload, withClient } from './mcp-server-test-client';
import type { ServerCoreMcpToolHost } from './mcp-tool-host';
import { ServerCoreSessionTaskReadRepository } from './session-task-read-repository';

const databases: Database.Database[] = [];
const roots: string[] = [];

function session(id: string, cwd: string, lifecycle: SessionRecord['lifecycle'] = 'active') {
  return {
    id,
    agentId: 'codex-cli',
    cwd,
    title: id,
    source: 'sdk',
    lifecycle,
    activity: 'working',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
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

function harness() {
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
    ['caller-a', session('caller-a', workspaceRoot)],
    ['caller-b', session('caller-b', workspaceRoot)],
  ]);
  const changes: Array<{ kind: string; entityId: string | null }> = [];
  const spawn = vi.fn(async (_callerId: string, args: {
    adapter: 'claude-code' | 'codex-cli' | 'grok-build';
    cwd: string;
    displayName?: string;
    agentName?: string;
  }) => ({
    sessionId: 'spawned-a',
    adapter: args.adapter,
    gateway: null,
    provider: null,
    cwd: args.cwd,
    teamId: null,
    teamName: null,
    displayName: args.displayName ?? args.agentName ?? null,
    agentName: args.agentName ?? null,
    spawnDepth: 1,
    spawnLimits: {
      depth: { current: 0, next: 1, max: 3 },
      fanOut: { current: 1, activeChildren: 1, inFlight: 0, max: 10 },
      rate: { current: 1, max: 20, windowMs: 60_000, retryAfterMs: 0 },
    },
    sentAt: 1,
    spawnPromptMessageId: 'message-spawn',
    contextMode: 'fresh' as const,
  }));
  const handOff = vi.fn(async () => ({
    sessionId: 'successor-a',
    adapter: 'codex-cli' as const,
    gateway: null,
    provider: 'openai',
    cwd: 'project-a',
    continuationContext: {
      version: 1,
      quality: 'raw-only' as const,
      sourceEventRevision: 2,
      cutoverEventRevision: 2,
      rebuildAfterRevision: 0,
      checkpoint: { id: null, formatVersion: 1, throughRevision: 0, refreshed: false },
      preparationHash: 'a'.repeat(64),
      tokenStats: {
        rawRetentionCeiling: 64_000,
        targetPromptCapacity: 64_000,
        checkpointProjectionBudget: 0,
        generatorFoldInputBudget: 0,
        estimatedPrompt: 100,
        checkpoint: 0,
        rawTail: 50,
      },
      includedUserMessages: 1,
      lateMessagesDelivered: 0,
      usedLowerBudgetRetry: false,
      truncatedBoundaryMessages: 0,
      foldCalls: 0,
      repairCalls: 0,
      warningCodes: [],
    },
    callerClosed: 'ok' as const,
    warnings: [],
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
    metrics: { estimatedPromptTokens: 100, checkpointTokens: 0, rawTailTokens: 50,
      includedUserMessages: 1, truncatedBoundaryMessages: 0,
      rawRetentionCeilingTokens: 64_000, elapsedMs: 1 },
    warnings: [], revision: 2,
    target: {
      adapterId: 'codex-cli' as const, workingDirectory: 'project-a',
      capabilityRevision: 'revision-a',
      options: { approvalPolicy: null, claudeCodeSandbox: null, codexSandbox: null,
        grokSandbox: null, model: null, permissionMode: null, provider: 'openai',
        sessionMode: null, thinking: null },
    },
  }));
  const tasks = new ServerCoreSessionTaskReadRepository(() => database, { warn: vi.fn() });
  const issues = new ServerCoreIssueRepository(() => database, { warn: vi.fn() });
  const host: ServerCoreMcpToolHost = {
    workspaceRoot,
    privateRoots: [],
    sessions: { get: (id) => records.get(id) ?? null },
    tasks,
    issues,
    collaboration: {
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      drainForHandOff: () => Promise.resolve(true),
      list: (_callerId, args) => {
        const rows = [...records.values()].filter((row) => row.lifecycle === (args.statusFilter ?? 'active'));
        return { total: rows.length, hasMore: false, sessions: rows.map((row) => ({
          sessionId: row.id,
          adapter: row.agentId,
          gateway: null,
          provider: null,
          cwd: '.',
          lifecycle: row.lifecycle,
          title: row.title,
          lastEventAt: row.lastEventAt,
          teamName: null,
          teams: [],
          spawnedBy: row.spawnedBy ?? null,
          spawnDepth: row.spawnDepth ?? 0,
        })) };
      },
      get: (_callerId, id) => {
        const row = records.get(id);
        if (!row) throw new Error('missing');
        return {
          sessionId: row.id,
          adapter: row.agentId,
          gateway: null,
          provider: null,
          cwd: '.',
          lifecycle: row.lifecycle,
          title: row.title,
          lastEventAt: row.lastEventAt,
          teamName: null,
          teams: [],
          spawnedBy: row.spawnedBy ?? null,
          spawnDepth: row.spawnDepth ?? 0,
        };
      },
      listEvents: (_callerId, args) => ({ sessionId: args.sessionId, hasMore: false, events: [] }),
      send: (_callerId, args) => ({
        sessionId: args.sessionId,
        teamId: args.teamId ?? null,
        messageId: 'message-a',
        replyToMessageId: args.replyToMessageId ?? null,
        sentAt: 1,
        queued: true,
      }),
      shutdown: async (_callerId, args) => ({
        sessionId: args.sessionId,
        lifecycle: 'closed',
        alreadyClosed: false,
      }),
    },
    spawn: { spawn },
    handoff: { handOff, preview },
    worktree: {
      enter: vi.fn(async (_callerId, args) => ({
        transitionId: 'caller-a:1',
        direction: 'enter' as const,
        state: 'waiting-tool-result' as const,
        effectiveFrom: 'automatic-next-turn' as const,
        worktreePath: args.worktreePath ?? '.agent-deck/worktrees/generated',
        startCommit: 'a'.repeat(40),
        headMode: 'detached' as const,
      })),
      exit: vi.fn(async () => ({
        transitionId: 'caller-a:1',
        direction: 'exit' as const,
        state: 'waiting-tool-result' as const,
        effectiveFrom: 'automatic-next-turn' as const,
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
  return { changes, database, handOff, host, issues, records, spawn, workspaceRoot };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Server Core MCP tools', () => {
  it('publishes the exact Core-owned collaboration, task, and Issue surface', async () => {
    const { host } = harness();
    const server = await createServerCoreMcpServer(
      host,
      () => 'caller-a',
      'codex-cli',
      { McpServer },
    );
    await withClient(server, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'append_issue_context',
        'browser_click',
        'browser_close',
        'browser_evaluate',
        'browser_navigate',
        'browser_open',
        'browser_press',
        'browser_read_console',
        'browser_read_network',
        'browser_screenshot',
        'browser_scroll',
        'browser_snapshot',
        'browser_tabs',
        'browser_type',
        'browser_wait',
        'enter_worktree',
        'exit_worktree',
        'get_session',
        'hand_off_session',
        'list_session_events',
        'list_sessions',
        'present_diff',
        'present_plan',
        'report_issue',
        'send_message',
        'shutdown_session',
        'spawn_session',
        'task_create',
        'task_delete',
        'task_get',
        'task_list',
        'task_update',
        'update_issue_status',
      ]);
      const tabs = await client.callTool({ name: 'browser_tabs', arguments: {} });
      expect(tabs.isError).not.toBe(true);
      expect(payload(tabs)).toEqual({ tabs: [] });
      expect(host.browser.invoke).toHaveBeenCalledWith('caller-a', 'browser_tabs', {});
      const plan = await client.callTool({
        name: 'present_plan',
        arguments: { plan: '# Remote plan' },
      });
      expect(payload(plan)).toEqual({ decision: 'approved' });
      expect(host.presentations.requestPlan).toHaveBeenCalledWith('caller-a', {
        plan: '# Remote plan',
      });
    });
  });

  it('revalidates the caller and enforces personal and active-team task authority', async () => {
    const { changes, host, records } = harness();
    const server = await createServerCoreMcpServer(
      host,
      () => 'caller-a',
      'codex-cli',
      { McpServer },
    );
    await withClient(server, async (client) => {
      const personal = await client.callTool({
        name: 'task_create',
        arguments: { subject: 'personal task' },
      });
      expect(personal.isError).not.toBe(true);
      expect(payload(personal)).toMatchObject({
        ownerSessionId: 'caller-a',
        subject: 'personal task',
        teamId: null,
      });

      const team = await client.callTool({
        name: 'task_create',
        arguments: { subject: 'team task', teamId: 'team-a' },
      });
      expect(team.isError).not.toBe(true);

      const denied = await createServerCoreMcpServer(
        host,
        () => 'caller-b',
        'codex-cli',
        { McpServer },
      );
      await withClient(denied, async (other) => {
        const result = await other.callTool({
          name: 'task_create',
          arguments: { subject: 'forbidden', teamId: 'team-a' },
        });
        expect(result.isError).toBe(true);
        expect(payload(result).error).toContain('not an active member');
      });

      records.set('caller-a', session('caller-a', host.workspaceRoot, 'closed'));
      const afterClose = await client.callTool({ name: 'task_list', arguments: {} });
      expect(afterClose.isError).toBe(true);
      expect(payload(afterClose).error).toContain('unavailable');
      expect(changes.map((change) => change.kind)).toEqual([
        'task.created',
        'task.created',
      ]);
    });
  });

  it('routes spawn_session through the authenticated Core caller with a relative cwd', async () => {
    const { host, spawn } = harness();
    const server = await createServerCoreMcpServer(
      host,
      () => 'caller-a',
      'codex-cli',
      { McpServer },
    );
    await withClient(server, async (client) => {
      const result = await client.callTool({
        name: 'spawn_session',
        arguments: {
          adapter: 'codex-cli',
          cwd: 'project-a',
          prompt: 'Inspect the project',
          displayName: 'Reviewer',
          agentName: 'reviewer-codex',
        },
      });
      expect(result.isError).not.toBe(true);
      expect(payload(result)).toMatchObject({
        sessionId: 'spawned-a',
        cwd: 'project-a',
        displayName: 'Reviewer',
        agentName: 'reviewer-codex',
      });
      expect(spawn).toHaveBeenCalledWith('caller-a', expect.objectContaining({
        cwd: 'project-a',
        agentName: 'reviewer-codex',
      }));
      const rejected = await client.callTool({
        name: 'spawn_session',
        arguments: { adapter: 'codex-cli', cwd: '/host/path', prompt: 'escape' },
      });
      expect(rejected.isError).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  it('routes hand_off_session through the authenticated caller without exposing host cwd', async () => {
    const { handOff, host } = harness();
    const server = await createServerCoreMcpServer(
      host,
      () => 'caller-a',
      'codex-cli',
      { McpServer },
    );
    await withClient(server, async (client) => {
      const result = await client.callTool({
        name: 'hand_off_session',
        arguments: { prompt: 'Continue remotely', cwd: 'project-a' },
      });
      expect(result.isError).not.toBe(true);
      expect(payload(result)).toMatchObject({
        sessionId: 'successor-a',
        cwd: 'project-a',
        callerClosed: 'ok',
      });
      expect(handOff).toHaveBeenCalledWith('caller-a', {
        prompt: 'Continue remotely',
        cwd: 'project-a',
      });
    });
  });

  it('keeps Issue cwd and source-lineage authority inside the Workspace', async () => {
    const { changes, host, issues, workspaceRoot } = harness();
    const server = await createServerCoreMcpServer(
      host,
      () => 'caller-a',
      'codex-cli',
      { McpServer },
    );
    await withClient(server, async (client) => {
      const escape = await client.callTool({
        name: 'report_issue',
        arguments: {
          title: 'escape',
          description: 'must fail',
          cwd: '..',
        },
      });
      expect(escape.isError).toBe(true);
      expect(payload(escape).error).toContain('escapes the Workspace');

      const created = await client.callTool({
        name: 'report_issue',
        arguments: {
          title: 'Remote issue',
          description: 'bounded evidence',
          cwd: '.',
        },
      });
      expect(created.isError).not.toBe(true);
      const createdPayload = payload(created);
      expect(createdPayload).toMatchObject({ cwd: '.', sourceSessionId: 'caller-a' });
      const issueId = String(createdPayload.id);
      expect(issues.get(issueId)?.cwd).toBe(workspaceRoot);

      const denied = await createServerCoreMcpServer(
        host,
        () => 'caller-b',
        'codex-cli',
        { McpServer },
      );
      await withClient(denied, async (other) => {
        const result = await other.callTool({
          name: 'append_issue_context',
          arguments: { issueId, additionalContext: 'not owned' },
        });
        expect(result.isError).toBe(true);
        expect(payload(result).error).toContain('current owner');
      });

      const appended = await client.callTool({
        name: 'append_issue_context',
        arguments: { issueId, additionalContext: 'new evidence' },
      });
      expect(appended.isError).not.toBe(true);
      expect(payload(appended).appendices).toHaveLength(1);
      expect(changes.map((change) => change.kind)).toEqual([
        'issue.created',
        'issue.updated',
      ]);
    });
  });
});
