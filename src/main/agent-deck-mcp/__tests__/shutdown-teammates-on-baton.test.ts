/**
 * shutdownTeammatesOnBaton helper 单测(CHANGELOG_106)。
 *
 * 范围:helper 内部逻辑(filter caller=lead 的 team / 收集 dedup teammate / 串行 close /
 * 单个失败容错)。完全 deps inject 模式,不依赖真 sessionManager / agentDeckTeamRepo,
 * 不依赖 DB 初始化。
 *
 * 与 archive-plan / hand-off-session handler 测试的边界:
 * - 这里测 helper 自身行为(返回 ShutdownTeammatesResult shape 的正确性)
 * - handler 测试通过 mock 整个 helper 函数,只验证「handler 调 helper + 包结果」集成
 *
 * 6 case 覆盖:
 * 1. caller 是单 team lead → close team 内 1 个 teammate + closed=[teammate]
 * 2. caller 不是任何 team 的 lead(只是 teammate / 无 membership)→ skipped='caller-not-lead'
 * 3. caller 是多 team lead 共享同 teammate sid → dedup,只 close 一次
 * 4. 单个 close 失败 → failed[] 收集 reason + 继续后面 teammate(不一刀切)
 * 5. external sentinel → 防御性早 return 'caller-not-lead'(handler 拦截不到这里的双保险)
 * 6. caller 是 lead 但 team 内只有 caller 自己 → closed=[] + skipped=null(正常处理无目标)
 */
import { describe, expect, it, vi } from 'vitest';
import log from 'electron-log/main';
import type { AgentDeckTeamMember } from '@shared/types';
import { shutdownTeammatesOnBaton } from '../tools/handlers/shutdown-teammates-on-baton';
import { EXTERNAL_CALLER_SENTINEL } from '../types';

// Step 3.3.5 后 shutdown-teammates-on-baton.ts 用 logger=log.scope('mcp-shutdown-teammates').warn
// 替代 console.warn。单个 close 失败兜底 warn 需 spy 此 scoped logger 而非 console.warn
// (vitest-setup.ts mock 已让 log.scope 返 vi.fn 化 logger)
const shutdownTeammatesLogger = log.scope('mcp-shutdown-teammates');

// helper:构造 AgentDeckTeamMember stub(简化默认值,只关心 teamId/sessionId/role)
function makeMember(opts: {
  teamId: string;
  sessionId: string;
  role: 'lead' | 'teammate';
}): AgentDeckTeamMember {
  return {
    teamId: opts.teamId,
    sessionId: opts.sessionId,
    role: opts.role,
    displayName: null,
    joinedAt: 1_000,
    leftAt: null,
  };
}

describe('shutdownTeammatesOnBaton helper(CHANGELOG_106)', () => {
  it('单 team lead → close 1 个 teammate', async () => {
    const closeCalls: string[] = [];
    const result = await shutdownTeammatesOnBaton('caller-sid', {
      findActiveMembershipsBySession: (sid) =>
        sid === 'caller-sid'
          ? [makeMember({ teamId: 'team-1', sessionId: 'caller-sid', role: 'lead' })]
          : [],
      listActiveMembers: (teamId) =>
        teamId === 'team-1'
          ? [
              makeMember({ teamId: 'team-1', sessionId: 'caller-sid', role: 'lead' }),
              makeMember({ teamId: 'team-1', sessionId: 'teammate-A', role: 'teammate' }),
            ]
          : [],
      closeFn: async (sid) => {
        closeCalls.push(sid);
      },
    });

    expect(result.closed).toEqual(['teammate-A']);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toBeNull();
    // caller 自己不被 close(filter m.sessionId !== callerSessionId)
    expect(closeCalls).toEqual(['teammate-A']);
  });

  it('caller 不是任何 team 的 lead(只是 teammate)→ skipped=caller-not-lead', async () => {
    const closeCalls: string[] = [];
    const result = await shutdownTeammatesOnBaton('caller-sid', {
      findActiveMembershipsBySession: () => [
        // caller 在 team 里仅是 teammate
        makeMember({ teamId: 'team-1', sessionId: 'caller-sid', role: 'teammate' }),
      ],
      listActiveMembers: () => [],
      closeFn: async (sid) => {
        closeCalls.push(sid);
      },
    });

    expect(result.closed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toBe('caller-not-lead');
    // 关键: closeFn 完全不被调用(caller 没领 lead 不牵连他人)
    expect(closeCalls).toEqual([]);
  });

  it('caller 在多个 team 都是 lead 共享同 teammate sid → dedup 只 close 一次', async () => {
    const closeCalls: string[] = [];
    const result = await shutdownTeammatesOnBaton('caller-sid', {
      findActiveMembershipsBySession: () => [
        makeMember({ teamId: 'team-1', sessionId: 'caller-sid', role: 'lead' }),
        makeMember({ teamId: 'team-2', sessionId: 'caller-sid', role: 'lead' }),
      ],
      listActiveMembers: (teamId) => {
        // team-1 / team-2 共享 teammate-X(典型: 同一 reviewer 加入两个 team)
        if (teamId === 'team-1') {
          return [
            makeMember({ teamId: 'team-1', sessionId: 'caller-sid', role: 'lead' }),
            makeMember({ teamId: 'team-1', sessionId: 'teammate-X', role: 'teammate' }),
          ];
        }
        if (teamId === 'team-2') {
          return [
            makeMember({ teamId: 'team-2', sessionId: 'caller-sid', role: 'lead' }),
            makeMember({ teamId: 'team-2', sessionId: 'teammate-X', role: 'teammate' }),
            makeMember({ teamId: 'team-2', sessionId: 'teammate-Y', role: 'teammate' }),
          ];
        }
        return [];
      },
      closeFn: async (sid) => {
        closeCalls.push(sid);
      },
    });

    // teammate-X dedup,只 close 一次(targetSids 是 Set)
    expect(closeCalls.sort()).toEqual(['teammate-X', 'teammate-Y']);
    expect(result.closed.sort()).toEqual(['teammate-X', 'teammate-Y']);
    expect(result.skipped).toBeNull();
  });

  it('单个 close 失败 → failed[] 收集 reason + 继续后面 teammate(不一刀切)', async () => {
    const closeCalls: string[] = [];
    const warnMock = shutdownTeammatesLogger.warn as ReturnType<typeof vi.fn>;
    warnMock.mockClear();

    const result = await shutdownTeammatesOnBaton('caller-sid', {
      findActiveMembershipsBySession: () => [
        makeMember({ teamId: 'team-1', sessionId: 'caller-sid', role: 'lead' }),
      ],
      listActiveMembers: () => [
        makeMember({ teamId: 'team-1', sessionId: 'caller-sid', role: 'lead' }),
        makeMember({ teamId: 'team-1', sessionId: 'teammate-fail', role: 'teammate' }),
        makeMember({ teamId: 'team-1', sessionId: 'teammate-ok', role: 'teammate' }),
      ],
      closeFn: async (sid) => {
        closeCalls.push(sid);
        if (sid === 'teammate-fail') {
          throw new Error('simulated close failure (FK constraint / SDK abort error)');
        }
      },
    });

    // 关键: 失败的 teammate 进 failed[],成功的进 closed[]
    expect(result.closed).toEqual(['teammate-ok']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].sessionId).toBe('teammate-fail');
    expect(result.failed[0].reason).toContain('simulated close failure');
    expect(result.skipped).toBeNull();
    // 关键: 失败 teammate 的 close 被尝试过,后面的 teammate close 仍然被调用(不短路)
    expect(closeCalls).toEqual(['teammate-fail', 'teammate-ok']);
    // warn 含 close failed 提示
    expect(warnMock).toHaveBeenCalledWith(
      expect.stringContaining('close(teammate-fail) failed'),
      expect.any(Error),
    );
  });

  it('external sentinel → 防御性早 return caller-not-lead(handler 拦截不到这里的双保险)', async () => {
    // 防御性: helper 在 EXTERNAL_CALLER_SENTINEL 早 return,不调任何 deps
    const findCalls: string[] = [];
    const closeCalls: string[] = [];

    const result = await shutdownTeammatesOnBaton(EXTERNAL_CALLER_SENTINEL, {
      findActiveMembershipsBySession: (sid) => {
        findCalls.push(sid);
        return [];
      },
      listActiveMembers: () => [],
      closeFn: async (sid) => {
        closeCalls.push(sid);
      },
    });

    expect(result).toEqual({
      closed: [],
      failed: [],
      skipped: 'caller-not-lead',
    });
    // 关键: 任何 deps fn 都不被调用(早 return 防御性短路)
    expect(findCalls).toEqual([]);
    expect(closeCalls).toEqual([]);
  });

  it('caller 是 lead 但 team 内只有 caller 自己 → closed=[] + skipped=null(无目标的正常处理)', async () => {
    const closeCalls: string[] = [];
    const result = await shutdownTeammatesOnBaton('caller-sid', {
      findActiveMembershipsBySession: () => [
        makeMember({ teamId: 'team-1', sessionId: 'caller-sid', role: 'lead' }),
      ],
      listActiveMembers: () => [
        // team 内只有 caller(典型: lead 起 team 后 reviewer 还没 spawn,或 reviewer 已 close)
        makeMember({ teamId: 'team-1', sessionId: 'caller-sid', role: 'lead' }),
      ],
      closeFn: async (sid) => {
        closeCalls.push(sid);
      },
    });

    expect(result.closed).toEqual([]);
    expect(result.failed).toEqual([]);
    // 关键: skipped=null 不是 'caller-not-lead'(caller 是 lead,只是没目标可 close)
    expect(result.skipped).toBeNull();
    expect(closeCalls).toEqual([]);
  });
});
