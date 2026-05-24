/**
 * hand_off_session handler caller cwd 反查 + generic mode 单测
 * （CHANGELOG_105 拆分自 hand-off-session.test.ts）。
 *
 * 范围：handOffSessionHandler
 * - caller cwd 反查（plan mcp-handoff-fix-and-skill-timer-20260514 Phase A1）
 * - generic mode (CHANGELOG_99)
 *
 * 不真起 git / 不真碰 fs / 不真起 SDK session：deps inject + vi.fn mock spawn handler，
 * vi.spyOn(sessionRepo) 局部 spy（与 handler-deny-happy sub-test 同款）。
 *
 * 其它范围：
 * - impl 五段 → hand-off-session.impl-core.test.ts
 * - handler deny + happy path → hand-off-session.handler-deny-happy.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { handOffSessionHandler } from '../tools/handlers/hand-off-session';
import type { HandOffSessionDeps } from '../tools/handlers/hand-off-session-impl';
import type { HandOffSessionArgs, SpawnSessionArgs } from '../tools/schemas';
import type { HandlerContext, HandlerResult } from '../tools/helpers';
import { sessionRepo } from '@main/store/session-repo';
import { makeState, makeDeps, planContent } from './hand-off-session/_setup';

describe('handOffSessionHandler — caller cwd 反查（plan mcp-handoff-fix-and-skill-timer-20260514 Phase A1）', () => {
  it('caller 不显式传 implDeps.cwd → handler 从 sessionRepo 反查 callerSession.cwd 注入到 impl', async () => {
    const planId = 'sessionrepo-injection';
    const planFilePath = `/Users/test/repo/.claude/plans/${planId}.md`;
    const callerSid = 'caller-with-cwd-in-repo';
    const callerCwd = '/Users/test/repo'; // sessionRepo 反查给 impl 的 cwd
    const fakeHomedir = '/Users/test';

    // mock sessionRepo.get：caller-with-cwd-in-repo → cwd = '/Users/test/repo'
    const sessionRepoGetSpy = vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) => {
      if (id === callerSid) {
        return {
          id: callerSid,
          adapter: 'claude-code',
          cwd: callerCwd,
          title: 'test session',
          lifecycle: 'active',
          archivedAt: null,
          permissionMode: null,
          codexSandbox: null,
          claudeCodeSandbox: null,
          createdAt: 1234,
          lastEventAt: 5678,
          spawnedBy: null,
          spawnDepth: 0,
        } as never;
      }
      return null;
    });

    // 自定义 deps：runGit 走真模拟（callerCwd → main repo /Users/test/repo），但 cwd
    // **不**注入（让 handler 走 sessionRepo 反查路径）；files / readFile 模拟正常
    const files = new Map<string, string>();
    files.set(planFilePath, planContent({ planId, status: 'in_progress' }));
    // REVIEW_33 H10：plan 默认 worktreePath = /Users/test/repo/.claude/worktrees/test-plan，
    // 加占位防 impl step 0 exists 检查 reject
    files.set('/Users/test/repo/.claude/worktrees/test-plan', '__dir__');
    const gitCallsSeen: Array<{ args: string[]; cwd: string }> = [];
    const partialDeps: HandOffSessionDeps = {
      runGit: async (args, cwd) => {
        gitCallsSeen.push({ args, cwd });
        if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
          return '/Users/test/repo/.git';
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`);
      },
      readFile: async (p) => {
        const c = files.get(p);
        if (c === undefined) throw new Error(`ENOENT: ${p}`);
        return c;
      },
      exists: async (p) => files.has(p),
      homedir: () => fakeHomedir,
      // **故意不传 cwd** — 验证 handler 注入路径
    };

    const mockSpawn = vi.fn(
      async (_args: SpawnSessionArgs, _ctx: HandlerContext): Promise<HandlerResult> => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ sessionId: 's', adapter: 'claude-code', cwd: '/x', teamName: null }),
          },
        ],
      }),
    );
    const mockArchive = vi.fn(async (_sid: string) => undefined);

    const args: HandOffSessionArgs = { plan_id: planId, adapter: 'claude-code' };
    const ctx: HandlerContext = {
      caller: { callerSessionId: callerSid, transport: 'in-process' },
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      implDeps: partialDeps,
    });

    expect(result.isError).toBeFalsy();
    // 验证：handler 从 sessionRepo 拿到 callerCwd 注入 impl，impl 的 runGit 用此 cwd 反查
    expect(gitCallsSeen).toHaveLength(1);
    expect(gitCallsSeen[0]!.cwd).toBe(callerCwd); // ← 关键：不是 process.cwd()
    expect(sessionRepoGetSpy).toHaveBeenCalledWith(callerSid);

    sessionRepoGetSpy.mockRestore();
  });

  it('caller 显式传 implDeps.cwd → 优先级最高（mergeCallerCwd 不反查 sessionRepo）', async () => {
    const planId = 'caller-explicit-cwd';
    const callerSid = 'should-not-be-queried-for-cwd';
    const explicitCwd = '/Users/test/explicit/cwd';
    const planFilePath = `${explicitCwd}/.claude/plans/${planId}.md`;
    const files = new Map<string, string>();
    files.set(planFilePath, planContent({ planId, status: 'in_progress' }));
    // REVIEW_33 H10：worktreePath 占位（plan 默认 wp = /Users/test/repo/.claude/worktrees/test-plan）
    files.set('/Users/test/repo/.claude/worktrees/test-plan', '__dir__');

    // CHANGELOG_98 / R2 reviewer-codex MED-2：F1 在 archive 路径独立加了
    // sessionRepo.get(callerSid) 探针，与 mergeCallerCwd 反查路径无关。本 case 原
    // intent 是「caller 显式 cwd → mergeCallerCwd 不反查 sessionRepo」，但 F1 加的
    // archive 探针仍会调 sessionRepo.get。改 spy 让 callerSid 有 fake row（让 archive
    // 路径走完）+ 用 gitCalls.cwd === explicitCwd 隐式验证 mergeCallerCwd 走 caller
    // 显式 cwd（不是 sessionRepo 反查的 cwd）。
    const sessionRepoGetSpy = vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) => {
      if (id === callerSid) {
        return {
          id: callerSid,
          agentId: 'claude-code',
          cwd: '/some/sessionrepo/cwd', // ≠ explicitCwd（用来验证 mergeCallerCwd 没用此值）
          title: 'fake',
          source: 'sdk',
          lifecycle: 'active',
          activity: 'idle',
          startedAt: 0,
          lastEventAt: 0,
          endedAt: null,
          archivedAt: null,
          spawnedBy: null,
          spawnDepth: 0,
        } as never;
      }
      return null;
    });

    const gitCallsSeen: Array<{ args: string[]; cwd: string }> = [];
    const explicitDeps: HandOffSessionDeps = {
      runGit: async (gitArgs, cwd) => {
        gitCallsSeen.push({ args: gitArgs, cwd });
        if (cwd === explicitCwd) return `${explicitCwd}/.git`;
        throw new Error(`unexpected cwd: ${cwd}`);
      },
      readFile: async (p) => files.get(p) ?? Promise.reject(new Error(`ENOENT: ${p}`)),
      exists: async (p) => files.has(p),
      cwd: () => explicitCwd, // ← caller 显式传
      homedir: () => '/Users/test',
    };

    const mockSpawn = vi.fn(
      async (_args: SpawnSessionArgs, _ctx: HandlerContext): Promise<HandlerResult> => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ sessionId: 's', adapter: 'claude-code', cwd: '/x', teamName: null }),
          },
        ],
      }),
    );
    const mockArchive = vi.fn(async (_sid: string) => undefined);

    const args: HandOffSessionArgs = { plan_id: planId, adapter: 'claude-code' };
    const ctx: HandlerContext = {
      caller: { callerSessionId: callerSid, transport: 'in-process' },
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      implDeps: explicitDeps,
    });

    expect(result.isError).toBeFalsy();
    // 关键验证：mergeCallerCwd 走 caller 显式 cwd（gitCalls.cwd === explicitCwd），**不是**
    // sessionRepo 反查的 cwd（'/some/sessionrepo/cwd'）。证明 mergeCallerCwd 优先 caller 显式。
    expect(gitCallsSeen).toHaveLength(1);
    expect(gitCallsSeen[0]!.cwd).toBe(explicitCwd);
    sessionRepoGetSpy.mockRestore();
  });
});

// ─── CHANGELOG_99 generic 模式（无 plan_id 通用 hand-off） ──────────────────

describe('handOffSessionHandler — generic mode (CHANGELOG_99)', () => {
  it('generic happy path: 不传 plan_id + 显式 prompt → spawn cwd = caller session cwd + ok return mode=generic', async () => {
    const state = makeState();

    const mockSpawn = vi.fn(
      async (_args: SpawnSessionArgs, _ctx: HandlerContext): Promise<HandlerResult> => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              sessionId: 'gen-sid',
              adapter: 'claude-code',
              cwd: '/Users/test/repo',
              teamId: null,
              teamName: null,
              spawnDepth: 1,
              sentAt: 100,
              spawnPromptMessageId: null,
            }),
          },
        ],
      }),
    );
    const mockArchive = vi.fn(async (_sid: string) => undefined);

    // mock callerRow.cwd → handler 用作 generic mode default cwd
    const sessionRepoGetSpy = vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) => {
      if (id === 'caller-sid') {
        return {
          id: 'caller-sid',
          agentId: 'claude-code',
          cwd: '/Users/test/some-caller-cwd',
          title: 'fake',
          source: 'sdk',
          lifecycle: 'active',
          activity: 'idle',
          startedAt: 0,
          lastEventAt: 0,
          endedAt: null,
          archivedAt: null,
          spawnedBy: null,
          spawnDepth: 0,
        } as never;
      }
      return null;
    });

    const args: HandOffSessionArgs = {
      adapter: 'claude-code',
      prompt: '继续上一会话的 fix',
    };
    const ctx: HandlerContext = {
      caller: { callerSessionId: 'caller-sid', transport: 'in-process' },
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      implDeps: makeDeps(state),
      // CHANGELOG_99 R1 fix MED-4 配套:虚构 caller cwd 真 fs 不存在,test 需 mock cwdExists
      cwdExists: () => true,
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    // 双模式标识 + plan-only 字段全 null
    expect(data.mode).toBe('generic');
    expect(data.planId).toBeNull();
    expect(data.planFilePath).toBeNull();
    expect(data.worktreePath).toBeNull();
    expect(data.baseBranch).toBeNull();
    expect(data.phaseLabel).toBeNull();
    // generic 模式 cold-start = args.prompt
    expect(data.initialPrompt).toBe('继续上一会话的 fix');
    expect(data.ignoredFields).toEqual([]);
    expect(data.archived).toBe('ok');

    // spawn cwd = caller session cwd（generic 模式 default,不是 mainRepo）
    const spawnArgs = mockSpawn.mock.calls[0]![0];
    expect(spawnArgs.cwd).toBe('/Users/test/some-caller-cwd');
    expect(spawnArgs.prompt).toBe('继续上一会话的 fix');
    expect(spawnArgs.team_name).toBeUndefined(); // baton 默认无 team

    sessionRepoGetSpy.mockRestore();
  });

  it('generic + caller cwd 缺失 → fallback mainRepo（caller 不在 sessionRepo / cwd 字段空）', async () => {
    const state = makeState(); // git rev-parse 仍成功 → mainRepo = '/Users/test/repo'

    const mockSpawn = vi.fn(
      async (_args: SpawnSessionArgs, _ctx: HandlerContext): Promise<HandlerResult> => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              sessionId: 'gen-sid-2',
              adapter: 'claude-code',
              cwd: '/Users/test/repo',
              teamId: null,
              teamName: null,
              spawnDepth: 1,
              sentAt: 100,
              spawnPromptMessageId: null,
            }),
          },
        ],
      }),
    );
    const mockArchive = vi.fn(async (_sid: string) => undefined);

    // sessionRepo.get 返回 null → callerSessionRow null → callerSessionCwd null → fallback mainRepo
    const sessionRepoGetSpy = vi.spyOn(sessionRepo, 'get').mockImplementation(() => null);

    const args: HandOffSessionArgs = {
      adapter: 'claude-code',
      prompt: 'fallback test',
    };
    const ctx: HandlerContext = {
      caller: { callerSessionId: 'caller-sid', transport: 'in-process' },
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    const spawnArgs = mockSpawn.mock.calls[0]![0];
    // callerCwd 拿不到 → fallback resolved.mainRepo
    expect(spawnArgs.cwd).toBe('/Users/test/repo');
    // archive failed (callerRow null)
    const data = JSON.parse(result.content[0]!.text);
    expect(data.archived).toBe('failed');

    sessionRepoGetSpy.mockRestore();
  });

  it('generic + 传 phase_label → ok return ignoredFields 含 phase_label', async () => {
    const state = makeState();

    const mockSpawn = vi.fn(
      async (_args: SpawnSessionArgs, _ctx: HandlerContext): Promise<HandlerResult> => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              sessionId: 'gen-sid-3',
              adapter: 'claude-code',
              cwd: '/Users/test/repo',
              teamId: null,
              teamName: null,
              spawnDepth: 1,
              sentAt: 100,
              spawnPromptMessageId: null,
            }),
          },
        ],
      }),
    );
    const mockArchive = vi.fn(async (_sid: string) => undefined);

    const sessionRepoGetSpy = vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) => {
      if (id === 'caller-sid') {
        return {
          id: 'caller-sid',
          agentId: 'claude-code',
          cwd: '/Users/test/repo',
          title: 'fake',
          source: 'sdk',
          lifecycle: 'active',
          activity: 'idle',
          startedAt: 0,
          lastEventAt: 0,
          endedAt: null,
          archivedAt: null,
          spawnedBy: null,
          spawnDepth: 0,
        } as never;
      }
      return null;
    });

    const args: HandOffSessionArgs = {
      adapter: 'claude-code',
      prompt: 'gen with ignored',
      phase_label: 'wrong-mode-label', // 在 generic 模式下被忽略
    };
    const ctx: HandlerContext = {
      caller: { callerSessionId: 'caller-sid', transport: 'in-process' },
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      implDeps: makeDeps(state),
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]!.text);
    expect(data.mode).toBe('generic');
    expect(data.ignoredFields).toEqual(['phase_label']);
    // phase_label 不影响 cold-start prompt
    expect(data.initialPrompt).toBe('gen with ignored');
    expect(data.phaseLabel).toBeNull();

    // plan handoff-render-and-image-batch-20260521 R1 reviewer-codex LOW 修法配套断言:
    // generic mode 时 spawnArgs.hand_off.phaseLabel 必须为 null(契约一致性 — 与 ok return
    // phaseLabel + ignoredFields 同步标 phase_label 被忽略)。修前 spawnArgs.hand_off.phaseLabel
    // 直接用 args.phase_label ?? null → events.payload / UI tooltip 显示 phase 但 ok return
    // 说被忽略,silent UI/metadata 漂移。
    const spawnArgsCaught = mockSpawn.mock.calls[0]![0];
    expect(spawnArgsCaught.hand_off).toEqual({
      mode: 'generic',
      planId: null,
      phaseLabel: null,
      fromCallerSid: 'caller-sid',
      hasAdoptedBlock: false,
    });

    sessionRepoGetSpy.mockRestore();
  });

  it('CHANGELOG_99 R1 fix MED-4: generic + caller cwd 真不存在 → existsSync precheck false → fallback mainRepo', async () => {
    const state = makeState();

    const mockSpawn = vi.fn(
      async (_args: SpawnSessionArgs, _ctx: HandlerContext): Promise<HandlerResult> => ({
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              sessionId: 'gen-sid-cwd-bad',
              adapter: 'claude-code',
              cwd: '/Users/test/repo',
              teamId: null,
              teamName: null,
              spawnDepth: 1,
              sentAt: 100,
              spawnPromptMessageId: null,
            }),
          },
        ],
      }),
    );
    const mockArchive = vi.fn(async (_sid: string) => undefined);

    // caller row 有 cwd 但 cwd 真 fs 不存在(典型场景:K2 老 session,cwd=worktree 已被
    // archive_plan 删)。mock cwdExists 返回 false 模拟。
    const sessionRepoGetSpy = vi.spyOn(sessionRepo, 'get').mockImplementation((id: string) => {
      if (id === 'caller-sid') {
        return {
          id: 'caller-sid',
          agentId: 'claude-code',
          cwd: '/Users/apple/myrepo/.claude/worktrees/dead-plan',
          title: 'fake',
          source: 'sdk',
          lifecycle: 'active',
          activity: 'idle',
          startedAt: 0,
          lastEventAt: 0,
          endedAt: null,
          archivedAt: null,
          spawnedBy: null,
          spawnDepth: 0,
        } as never;
      }
      return null;
    });

    const args: HandOffSessionArgs = {
      adapter: 'claude-code',
      prompt: 'caller cwd dead, fallback test',
    };
    const ctx: HandlerContext = {
      caller: { callerSessionId: 'caller-sid', transport: 'in-process' },
    };

    const result = await handOffSessionHandler(args, ctx, {
      spawnSession: mockSpawn,
      archiveSession: mockArchive,
      implDeps: makeDeps(state),
      // Mock cwdExists:caller cwd 不存在,其他存在
      cwdExists: (p: string) => p !== '/Users/apple/myrepo/.claude/worktrees/dead-plan',
    });

    expect(result.isError).toBeFalsy();
    const spawnArgs = mockSpawn.mock.calls[0]![0];
    // callerCwd existsSync precheck false → fallback resolved.mainRepo
    expect(spawnArgs.cwd).toBe('/Users/test/repo');

    sessionRepoGetSpy.mockRestore();
  });
});
