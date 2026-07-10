import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import { handOffSessionHandler, resolveBatonRoleForSpawn } from '../tools/handlers/hand-off-session';
import type { HandlerContext, HandlerResult } from '../tools/helpers';
import type { HandOffSessionArgs, SpawnSessionArgs } from '../tools/schemas';
import type { SessionRecord } from '@shared/types';

function parseResult(result: HandlerResult): any {
  return JSON.parse(result.content[0]?.text ?? '{}');
}

function callerRow(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'caller-sid',
    agentId: 'claude-code',
    cwd: '/repo',
    title: 'caller',
    source: 'sdk',
    lifecycle: 'active',
    activity: 'idle',
    startedAt: 1,
    lastEventAt: 1,
    endedAt: null,
    archivedAt: null,
    ...overrides,
  } as SessionRecord;
}

function ctx(): HandlerContext {
  return {
    caller: {
      callerSessionId: 'caller-sid',
      transport: 'in-process',
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handOffSessionHandler', () => {
  it('rejects external callers before spawning a successor', async () => {
    const result = await handOffSessionHandler(
      { prompt: 'continue from /tmp/handoff.md', adapter: 'claude-code' },
      { caller: { callerSessionId: '__external__', transport: 'stdio' } },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('not allowed for external caller');
  });

  it('spawns prompt-only successor, transfers resources, and closes caller', async () => {
    vi.spyOn(sessionRepo, 'get').mockReturnValue(callerRow({ cwdReleaseMarker: null }));

    const seen: { args?: SpawnSessionArgs; opts?: { handOffMode?: boolean; batonRole?: string } } = {};
    const spawnSession = vi.fn(
      async (
        args: SpawnSessionArgs,
        _ctx: HandlerContext,
        opts?: { handOffMode?: boolean; batonRole?: 'lead' | 'teammate' },
      ): Promise<HandlerResult> => {
        seen.args = args;
        seen.opts = opts;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                sessionId: 'successor-sid',
                adapter: args.adapter,
                cwd: args.cwd,
                teamId: null,
                teamName: null,
                agentName: null,
                displayName: null,
                spawnDepth: 0,
                spawnLimits: {
                  depth: { current: 0, next: 0, max: 3 },
                  fanOut: { current: 0, activeChildren: 0, inFlight: 0, max: 5 },
                  rate: { current: 0, max: 100, windowMs: 60_000, retryAfterMs: 0 },
                },
                sentAt: 123,
                spawnPromptMessageId: null,
              }),
            },
          ],
        };
      },
    );
    const closeSession = vi.fn(async (_sid: string) => undefined);
    const transferResources = vi.fn(() => ({
      tasks: { status: 'ok' as const, count: 2 },
      teams: { status: 'ok' as const, transferred: [], skipped: [], failed: [] },
      worktreeMarker: { status: 'skipped' as const, marker: null },
    }));

    const args: HandOffSessionArgs = {
      prompt: 'Read /tmp/handoff-123.md, then continue the work.',
      adapter: 'codex-cli',
      cwd: '/repo',
    };

    const result = await handOffSessionHandler(args, ctx(), {
      spawnSession,
      closeSession,
      transferResources,
      cwdExists: (p) => p === '/repo',
    });

    expect(result.isError).toBeFalsy();
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(transferResources).toHaveBeenCalledWith({
      callerSessionId: 'caller-sid',
      callerRow: expect.objectContaining({ id: 'caller-sid' }),
      newSessionId: 'successor-sid',
    });
    expect(seen.opts).toEqual({ handOffMode: true, batonRole: 'lead' });
    expect(seen.args).toMatchObject({
      adapter: 'codex-cli',
      cwd: '/repo',
      prompt: args.prompt,
      handOff: { mode: 'session', fromCallerSid: 'caller-sid' },
    });
    expect(seen.args).not.toHaveProperty('contextMode');
    expect(closeSession).toHaveBeenCalledWith('caller-sid');

    const data = parseResult(result);
    expect(data.initialPrompt).toBe(args.prompt);
    expect(data.sessionId).toBe('successor-sid');
    expect(data.callerClosed).toBe('ok');
    expect(data.resourceTransfer.worktreeMarker).toEqual({ status: 'skipped', marker: null });
  });

  it('default caller close keeps post-handoff tail events visible by not marking recentlyDeleted', async () => {
    vi.spyOn(sessionRepo, 'get').mockReturnValue(callerRow({ cwdReleaseMarker: null }));
    const markClosed = vi.spyOn(sessionManager, 'markClosed').mockImplementation(() => undefined);
    const markRecentlyDeleted = vi
      .spyOn(sessionManager, 'markRecentlyDeleted')
      .mockImplementation(() => undefined);
    const release = vi.spyOn(mcpSessionTokenMap, 'release').mockImplementation(() => undefined);
    const spawnSession = vi.fn(async (args: SpawnSessionArgs): Promise<HandlerResult> => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            sessionId: 'successor-sid',
            adapter: args.adapter,
            cwd: args.cwd,
            teamId: null,
            teamName: null,
            agentName: null,
            displayName: null,
            spawnDepth: 0,
            spawnLimits: {
              depth: { current: 0, next: 0, max: 3 },
              fanOut: { current: 0, activeChildren: 0, inFlight: 0, max: 5 },
              rate: { current: 0, max: 100, windowMs: 60_000, retryAfterMs: 0 },
            },
            sentAt: 123,
            spawnPromptMessageId: null,
          }),
        },
      ],
    }));

    const result = await handOffSessionHandler(
      { prompt: 'continue', adapter: 'claude-code' },
      ctx(),
      {
        spawnSession,
        cwdExists: () => true,
        transferResources: () => ({
          tasks: { status: 'ok', count: 0 },
          teams: { status: 'ok', transferred: [], skipped: [], failed: [] },
          worktreeMarker: { status: 'skipped', marker: null },
        }),
      },
    );

    expect(result.isError).toBeFalsy();
    expect(markClosed).toHaveBeenCalledWith('caller-sid');
    expect(markRecentlyDeleted).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith('caller-sid');
  });

  it('closes the successor but not the caller when mandatory resource transfer fails', async () => {
    vi.spyOn(sessionRepo, 'get').mockReturnValue(callerRow());
    const spawnSession = vi.fn(async (): Promise<HandlerResult> => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            sessionId: 'successor-sid',
            adapter: 'claude-code',
            cwd: '/repo',
            teamId: null,
            teamName: null,
            agentName: null,
            displayName: null,
            spawnDepth: 0,
            spawnLimits: {
              depth: { current: 0, next: 0, max: 3 },
              fanOut: { current: 0, activeChildren: 0, inFlight: 0, max: 5 },
              rate: { current: 0, max: 100, windowMs: 60_000, retryAfterMs: 0 },
            },
            sentAt: 123,
            spawnPromptMessageId: null,
          }),
        },
      ],
    }));
    const closeSession = vi.fn(async (_sid: string) => undefined);

    const result = await handOffSessionHandler(
      { prompt: 'continue', adapter: 'claude-code' },
      ctx(),
      {
        spawnSession,
        closeSession,
        cwdExists: () => true,
        transferResources: () => ({
          tasks: {
            status: 'failed',
            count: 0,
            error: 'skipped task transfer because team transfer failed',
          },
          teams: {
            status: 'failed',
            transferred: [],
            skipped: [],
            failed: [{ teamId: 'team-A', role: 'lead', reason: 'swap failed' }],
          },
          worktreeMarker: { status: 'skipped', marker: null },
        }),
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('caller was not closed');
    expect(result.content[0]?.text).toContain('successor-sid');
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledWith('successor-sid');
    expect(closeSession).not.toHaveBeenCalledWith('caller-sid');

    const data = parseResult(result);
    expect(data.successorSessionId).toBe('successor-sid');
    expect(data.successorClosed).toBe('ok');
    expect(data.resourceTransfer.teams.failed).toEqual([
      { teamId: 'team-A', role: 'lead', reason: 'swap failed' },
    ]);
  });

  it('reports successor cleanup failure when transfer failure cleanup cannot close the spawned session', async () => {
    vi.spyOn(sessionRepo, 'get').mockReturnValue(callerRow());
    const spawnSession = vi.fn(async (): Promise<HandlerResult> => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            sessionId: 'successor-sid',
            adapter: 'claude-code',
            cwd: '/repo',
            teamId: null,
            teamName: null,
            agentName: null,
            displayName: null,
            spawnDepth: 0,
            spawnLimits: {
              depth: { current: 0, next: 0, max: 3 },
              fanOut: { current: 0, activeChildren: 0, inFlight: 0, max: 5 },
              rate: { current: 0, max: 100, windowMs: 60_000, retryAfterMs: 0 },
            },
            sentAt: 123,
            spawnPromptMessageId: null,
          }),
        },
      ],
    }));
    const closeSession = vi.fn(async (_sid: string) => {
      throw new Error('close failed');
    });

    const result = await handOffSessionHandler(
      { prompt: 'continue', adapter: 'claude-code' },
      ctx(),
      {
        spawnSession,
        closeSession,
        cwdExists: () => true,
        transferResources: () => ({
          tasks: { status: 'failed', count: 0, error: 'task db failed' },
          teams: {
            status: 'failed',
            transferred: [],
            skipped: [],
            failed: [
              {
                teamId: '*',
                role: 'teammate',
                reason: 'skipped team transfer because task transfer failed',
              },
            ],
          },
          worktreeMarker: { status: 'skipped', marker: null },
        }),
      },
    );

    expect(result.isError).toBe(true);
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(closeSession).toHaveBeenCalledWith('successor-sid');
    expect(closeSession).not.toHaveBeenCalledWith('caller-sid');

    const data = parseResult(result);
    expect(data.successorSessionId).toBe('successor-sid');
    expect(data.successorClosed).toBe('failed');
  });

  it('rejects missing cwd before spawning', async () => {
    vi.spyOn(sessionRepo, 'get').mockReturnValue(callerRow({ cwd: '/missing' }));
    const spawnSession = vi.fn();

    const result = await handOffSessionHandler(
      { prompt: 'continue', adapter: 'claude-code' },
      ctx(),
      { spawnSession, cwdExists: () => false },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('handoff cwd does not exist');
    expect(spawnSession).not.toHaveBeenCalled();
  });
});

describe('resolveBatonRoleForSpawn', () => {
  it('always uses handoff lead mode', () => {
    expect(resolveBatonRoleForSpawn()).toEqual({ handOffMode: true, batonRole: 'lead' });
  });
});
