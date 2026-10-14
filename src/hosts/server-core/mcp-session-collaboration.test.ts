import type Database from 'better-sqlite3';
import { join } from 'node:path';

import type { AgentAdapter } from '@main/adapters/types';
import { createAgentDeckMessageRepo } from '@main/store/agent-deck-message-repo';
import { createAgentDeckTeamRepo } from '@main/store/agent-deck-team-repo';
import {
  insertSession,
  makeMemoryDb,
} from '@main/store/__tests__/agent-deck-repos/_setup';
import type { SessionRecord, StoredAgentEvent } from '@shared/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { LIST_SESSIONS_SCHEMA } from '@main/agent-deck-mcp/tools/schemas';

import { ServerCoreMcpSessionCollaboration } from './mcp-session-collaboration';

const databases: Database.Database[] = [];
const collaborations: ServerCoreMcpSessionCollaboration[] = [];

function session(
  id: string,
  cwd: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id,
    agentId: 'codex-cli',
    cwd,
    title: `title-${id}`,
    source: 'sdk',
    lifecycle: 'active',
    activity: 'working',
    startedAt: 1,
    lastEventAt: 2,
    endedAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function harness() {
  const workspaceRoot = '/srv/agent-deck/workspace';
  const privateRoot = '/srv/agent-deck/private';
  const records = new Map<string, SessionRecord>([
    ['caller', session('caller', workspaceRoot)],
    ['child', session('child', join(workspaceRoot, 'project-a'), {
      spawnedBy: 'caller',
      spawnDepth: 1,
    })],
    ['peer', session('peer', join(workspaceRoot, 'project-b'))],
    ['stranded', session('stranded', '/elsewhere/secret', {
      spawnedBy: 'old-lead',
      spawnDepth: 2,
    })],
  ]);
  const database = makeMemoryDb();
  databases.push(database);
  for (const row of records.values()) insertSession(database, row.id, row.agentId);
  const teams = createAgentDeckTeamRepo(database);
  const messages = createAgentDeckMessageRepo(database);
  const receiveTeammateMessage = vi.fn(async () => undefined);
  const runtimeCwds = new Map<string, string>();
  const closeAdapterSession = vi.fn(async (sessionId: string) => {
    runtimeCwds.delete(sessionId);
  });
  const closeSession = vi.fn(async (sessionId: string) => {
    const row = records.get(sessionId);
    if (row) records.set(sessionId, { ...row, lifecycle: 'closed', endedAt: 3 });
  });
  const changes: Array<{ kind: string; entityId: string | null }> = [];
  const events = new Map<string, StoredAgentEvent[]>();
  const adapter = {
    id: 'codex-cli',
    capabilities: { canCollaborate: true },
    receiveTeammateMessage,
    closeSession: closeAdapterSession,
    getRuntimeCwd: (sessionId: string) => runtimeCwds.get(sessionId) ?? null,
  } as unknown as AgentAdapter;
  const successors = new Map<string, string>();
  const requestShutdownApproval = vi.fn(async (_id: string, args: import('@main/agent-deck-mcp/tools/schemas/ask-user').AskUserArgs) => ({
    status: 'answered' as const, answers: [{ question: args.questions[0].question, selected: ['确认关闭'] }],
  }));
  const collaboration = new ServerCoreMcpSessionCollaboration({
    workspaceRoot,
    privateRoots: [privateRoot],
    sessions: {
      get: (id) => records.get(id) ?? null,
      findByCliSessionId: (id) => records.get(id) ?? null,
      listActiveAndDormant: (limit, offset, lifecycle, spawnedBy, agentId) =>
        [...records.values()]
          .filter((row) => row.archivedAt === null)
          .filter((row) => row.lifecycle === (lifecycle ?? row.lifecycle))
          .filter((row) => !spawnedBy || row.spawnedBy === spawnedBy)
          .filter((row) => !agentId || row.agentId === agentId)
          .slice(offset, offset + limit),
      listHistory: ({ limit, offset, spawnedBy, agentId }) =>
        [...records.values()]
          .filter((row) => row.lifecycle === 'closed' || row.archivedAt !== null)
          .filter((row) => !spawnedBy || row.spawnedBy === spawnedBy)
          .filter((row) => !agentId || row.agentId === agentId)
          .slice(offset, offset + limit),
    },
    events: {
      listValidForSession: (id, limit, offset) =>
        (events.get(id) ?? []).slice(offset, offset + limit),
    },
    teams,
    messages,
    successor: (id) => successors.get(id) ?? null,
    ownershipLineage: (id) => [id, ...[...successors].filter(([, to]) => to === id).map(([from]) => from)],
    requestShutdownApproval,
    closeSession,
    adapter: () => adapter,
    appendChange: (kind, entityId) => changes.push({ kind, entityId }),
    now: () => 10_000,
  });
  collaborations.push(collaboration);
  return {
    database, successors, requestShutdownApproval,
    changes,
    closeAdapterSession,
    closeSession,
    collaboration,
    events,
    messages,
    privateRoot,
    receiveTeammateMessage,
    records,
    runtimeCwds,
    teams,
    workspaceRoot,
  };
}

afterEach(async () => {
  for (const collaboration of collaborations.splice(0)) await collaboration.stop();
  for (const database of databases.splice(0)) database.close();
});

describe('ServerCoreMcpSessionCollaboration', () => {
  it.each([undefined, 'related', 'all'])(
    'defaults to related open metadata and expands only with all scope (%s)', (scope) => {
      const state = harness();
      state.records.get('child')!.lifecycle = 'dormant';
      state.records.get('peer')!.lifecycle = 'dormant';
      state.records.set('closed-child', session('closed-child', state.workspaceRoot, {
        spawnedBy: 'caller', lifecycle: 'closed',
      }));
      const visible = state.collaboration.list('caller', z.object(LIST_SESSIONS_SCHEMA).parse({ scope }));
      expect(visible.sessions.map((row) => row.sessionId)).toEqual(
        scope === 'all' ? ['caller', 'child', 'peer'] : ['caller', 'child'],
      );
      expect(visible.sessions.map((row) => row.cwd)).toEqual(
        scope === 'all' ? ['.', 'project-a', 'project-b'] : ['.', 'project-a'],
      );

      const recovered = state.collaboration.list('caller', {
        scope: 'all',
        statusFilter: 'active',
        spawnedByFilter: 'old-lead',
        limit: 50,
        offset: 0,
      });
      expect(recovered.sessions).toHaveLength(0);
      expect(state.collaboration.get('caller', 'peer').cwd).toBe('project-b');
    },
  );

  it('does not let a parent filter expand the default related scope', () => {
    const state = harness();
    state.records.get('peer')!.spawnedBy = 'old-lead';
    const filters = z.object(LIST_SESSIONS_SCHEMA).parse({ spawnedByFilter: 'old-lead' });
    expect(state.collaboration.list('caller', filters).sessions).toEqual([]);
    expect(state.collaboration.list('caller', { ...filters, scope: 'all' }).sessions
      .map(row => row.sessionId)).toEqual(['peer']);
  });

  it('bounds related event reads and removes private, outside, attachment, and binary data', () => {
    const state = harness();
    state.events.set('child', [{
      id: 1,
      sessionId: 'child',
      agentId: 'codex-cli',
      kind: 'message',
      payload: {
        cwd: join(state.workspaceRoot, 'project-a'),
        filePath: '/outside/value.txt',
        privatePath: join(state.privateRoot, 'token.json'),
        base64: 'sensitive-binary',
        attachments: [{ path: '/outside/image.png' }],
      },
      ts: 3,
    }]);
    const result = state.collaboration.listEvents('caller', {
      sessionId: 'child',
      limit: 100,
      offset: 0,
    });
    expect(result.events[0]?.payload).toEqual({
      cwd: 'Workspace/project-a',
      filePath: '[outside Workspace]',
      privatePath: '[private]',
      base64: '[远程视图已省略二进制内容]',
      attachments: [],
    });
    expect(() => state.collaboration.listEvents('caller', {
      sessionId: 'peer',
      limit: 100,
      offset: 0,
    }))
      .toThrow('outside the caller collaboration scope');
  });

  it('delivers teamless and team messages through the target adapter with durable wire identity', async () => {
    const state = harness();
    await state.collaboration.start();
    const direct = state.collaboration.send('caller', {
      sessionId: 'peer',
      text: 'please inspect',
    });
    expect(direct.teamId).toBeNull();
    await vi.waitFor(() => expect(state.receiveTeammateMessage).toHaveBeenCalledTimes(1));
    expect(state.receiveTeammateMessage).toHaveBeenCalledWith(
      'peer',
      'caller',
      expect.stringMatching(
        new RegExp(`^\\[from title-caller @ codex-cli\\]\\[msg ${direct.messageId}\\]`),
      ),
      direct.messageId,
    );
    await vi.waitFor(() => {
      expect(state.messages.get(direct.messageId)?.status).toBe('delivered');
    });

    const team = state.teams.create({ name: 'review' });
    state.teams.addMember({ teamId: team.id, sessionId: 'caller', role: 'lead' });
    state.teams.addMember({ teamId: team.id, sessionId: 'child', role: 'teammate' });
    const scoped = state.collaboration.send('caller', {
      sessionId: 'child',
      text: 'bounded task',
    });
    expect(scoped.teamId).toBe(team.id);
    await vi.waitFor(() => expect(state.receiveTeammateMessage).toHaveBeenCalledTimes(2));
    expect(state.changes.some((change) => change.kind === 'message.updated')).toBe(true);
  });

  it('fences reply scope and requires user approval to close an unrelated session', async () => {
    const state = harness();
    await state.collaboration.start();
    const first = state.collaboration.send('caller', {
      sessionId: 'peer',
      text: 'first',
    });
    expect(() => state.collaboration.send('child', {
      sessionId: 'peer',
      text: 'cross pair',
      replyToMessageId: first.messageId,
    })).toThrow('another session pair');
    await expect(state.collaboration.shutdown('caller', {
      sessionId: 'peer',
      reason: 'done',
    })).resolves.toEqual({
      sessionId: 'peer',
      lifecycle: 'closed',
      alreadyClosed: false,
    });
    expect(state.requestShutdownApproval).toHaveBeenCalledOnce();
    expect(state.closeSession).toHaveBeenCalledWith('peer');
    await expect(state.collaboration.shutdown('caller', { sessionId: 'caller' }))
      .rejects.toThrow('caller session');
  });

  it('retains predecessor children and delivered teamless reply anchors after handoff', async () => {
    const state = harness();
    await state.collaboration.start();
    insertSession(state.database, 'successor', 'codex-cli');
    const wire = state.collaboration.send('caller', { sessionId: 'child', text: 'work' });
    state.messages.markDelivered(wire.messageId, 10001);
    state.records.set('successor', session('successor', state.workspaceRoot));
    state.records.get('caller')!.lifecycle = 'closed';
    state.successors.set('caller', 'successor');
    const related = state.collaboration.list('successor', {
      statusFilter: 'open', scope: 'related', limit: 50, offset: 0,
    });
    expect(related.sessions.map(row => row.sessionId)).toEqual(['child', 'successor']);
    expect(state.collaboration.listEvents('successor', { sessionId: 'child', limit: 100, offset: 0 }).events).toEqual([]);
    const reply = state.collaboration.send('child', {
      sessionId: 'caller', text: 'done', replyToMessageId: wire.messageId,
    });
    expect(reply.sessionId).toBe('successor');
    await state.collaboration.shutdown('successor', { sessionId: 'child' });
    expect(state.requestShutdownApproval).not.toHaveBeenCalled();
  });

  it('re-runs adapter retirement for an already-closed session without rewriting it', async () => {
    const state = harness();
    const closed = state.records.get('peer')!;
    state.records.set('peer', { ...closed, lifecycle: 'closed', endedAt: 3 });
    state.runtimeCwds.set('peer', join(state.workspaceRoot, 'project-b'));

    await expect(state.collaboration.shutdown('caller', {
      sessionId: 'peer',
      reason: 'release stale worktree runtime',
    })).resolves.toEqual({
      sessionId: 'peer',
      lifecycle: 'closed',
      alreadyClosed: true,
    });

    expect(state.closeSession).not.toHaveBeenCalled();
    expect(state.closeAdapterSession).toHaveBeenCalledWith('peer');
    expect(state.runtimeCwds.has('peer')).toBe(false);
    expect(state.records.get('peer')?.endedAt).toBe(3);
  });
});
