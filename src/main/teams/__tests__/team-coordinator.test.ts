/**
 * team-coordinator 单测：覆盖 sync() 三态（不存在 / 幂等 / 真写）+ extractTeamNameFromToolInput
 * 4 种工具 × 多种字段名命中 / 不命中。
 *
 * 不测 fs watcher（chokidar 行为依赖真 fs，且本应用其他模块用 chokidar 已 e2e 验证；本文件
 * 只测 sync 收口与 PreToolUse 抽 team 名 helper 的纯逻辑）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 必须在 import 被测模块之前 mock 它的依赖
vi.mock('@main/store/session-repo', () => {
  const map = new Map<
    string,
    {
      id: string;
      teamName: string | null;
      agentId: string;
      cwd: string;
      title: string;
      source: string;
      lifecycle: string;
      activity: string;
      startedAt: number;
      lastEventAt: number;
      endedAt: number | null;
      archivedAt: number | null;
    }
  >();
  return {
    sessionRepo: {
      get: vi.fn((id: string) => {
        const s = map.get(id);
        // REVIEW_17 R1 / M5：返回 shallow copy 而不是 map 内对象本身，
        // 模拟真实 SQLite 「每次 SELECT 拿一份新行」语义。否则后续 setTeamName
        // 会修改同一对象引用，sync() 内部 console.log 拿到的「旧值」实际已被改成新值。
        return s ? { ...s } : null;
      }),
      setTeamName: vi.fn((id: string, teamName: string | null) => {
        const s = map.get(id);
        // 同样：写新对象而不是原地改，与 SQLite UPDATE 语义对齐。
        if (s) map.set(id, { ...s, teamName });
      }),
      // 测试 helper：让单测直接塞 session 进 mock map
      __setMockSession: (id: string, teamName: string | null = null) => {
        map.set(id, {
          id,
          teamName,
          agentId: 'claude-code',
          cwd: '/tmp',
          title: 'test',
          source: 'sdk',
          lifecycle: 'active',
          activity: 'idle',
          startedAt: 0,
          lastEventAt: 0,
          endedAt: null,
          archivedAt: null,
        });
      },
      __clearMockSessions: () => map.clear(),
    },
  };
});

vi.mock('@main/event-bus', () => ({
  eventBus: {
    emit: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('./team-fs', () => ({
  getTeamsRoot: () => '/tmp/test-claude-teams', // 不会真用到（fs watcher 不在此测）
}));

import { teamCoordinator, extractTeamNameFromToolInput } from '../team-coordinator';
import { sessionRepo } from '@main/store/session-repo';
import { eventBus } from '@main/event-bus';

interface SessionRepoMock {
  __setMockSession: (id: string, teamName?: string | null) => void;
  __clearMockSessions: () => void;
}

const mockRepo = sessionRepo as unknown as typeof sessionRepo & SessionRepoMock;

describe('teamCoordinator.sync', () => {
  beforeEach(() => {
    mockRepo.__clearMockSessions();
    vi.mocked(sessionRepo.setTeamName).mockClear();
    vi.mocked(eventBus.emit).mockClear();
  });

  it('session 不存在 → no-op，不写 DB 不 emit', () => {
    teamCoordinator.sync('nonexistent-sid', 'team-X', 'pretool');
    expect(sessionRepo.setTeamName).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('幂等：team_name 已等于目标值 → no-op', () => {
    mockRepo.__setMockSession('sid-1', 'team-X');
    teamCoordinator.sync('sid-1', 'team-X', 'fs');
    expect(sessionRepo.setTeamName).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('从 null 同步到 team-X → 写 DB + emit session-upserted', () => {
    mockRepo.__setMockSession('sid-2', null);
    teamCoordinator.sync('sid-2', 'team-X', 'pretool');
    expect(sessionRepo.setTeamName).toHaveBeenCalledWith('sid-2', 'team-X');
    expect(eventBus.emit).toHaveBeenCalledWith(
      'session-upserted',
      expect.objectContaining({ id: 'sid-2', teamName: 'team-X' }),
    );
  });

  it('从 team-X 同步到 team-Y（rename）→ 写 DB + emit', () => {
    mockRepo.__setMockSession('sid-3', 'team-X');
    teamCoordinator.sync('sid-3', 'team-Y', 'hook');
    expect(sessionRepo.setTeamName).toHaveBeenCalledWith('sid-3', 'team-Y');
    expect(eventBus.emit).toHaveBeenCalled();
  });

  it.each([
    ['pretool' as const],
    ['fs' as const],
    ['hook' as const],
  ])('source=%s 走同款 sync 路径', (source) => {
    mockRepo.__setMockSession(`sid-${source}`, null);
    teamCoordinator.sync(`sid-${source}`, 'team-A', source);
    expect(sessionRepo.setTeamName).toHaveBeenCalledWith(`sid-${source}`, 'team-A');
  });

  it('空字符串 sessionId 或 teamName → no-op（防 hook payload 字段缺失）', () => {
    mockRepo.__setMockSession('sid-x', null);
    teamCoordinator.sync('', 'team-X', 'hook');
    teamCoordinator.sync('sid-x', '', 'hook');
    expect(sessionRepo.setTeamName).not.toHaveBeenCalled();
  });
});

describe('extractTeamNameFromToolInput', () => {
  describe('TeamCreate / TeamDelete', () => {
    it.each([
      ['TeamCreate', { name: 'my-team' }, 'my-team'],
      ['TeamCreate', { team_name: 'snake-case' }, 'snake-case'],
      ['TeamCreate', { teamName: 'camelCase' }, 'camelCase'],
      ['TeamCreate', { team: 'short' }, 'short'],
      ['TeamDelete', { name: 'doomed-team' }, 'doomed-team'],
    ])('%s + %j → %s', (toolName, input, expected) => {
      expect(extractTeamNameFromToolInput(toolName, input)).toBe(expected);
    });

    it('优先级 name > team_name > teamName > team', () => {
      expect(
        extractTeamNameFromToolInput('TeamCreate', {
          name: 'first',
          team_name: 'second',
          teamName: 'third',
          team: 'fourth',
        }),
      ).toBe('first');
    });
  });

  describe('Teammate / SendMessage', () => {
    it.each([
      ['Teammate', { team_name: 'my-team', name: 'reviewer-claude' }, 'my-team'],
      ['Teammate', { teamName: 'camel' }, 'camel'],
      ['Teammate', { team: 'short' }, 'short'],
      ['SendMessage', { team_name: 'my-team', to: 'reviewer-claude' }, 'my-team'],
    ])('%s + %j → %s', (toolName, input, expected) => {
      expect(extractTeamNameFromToolInput(toolName, input)).toBe(expected);
    });

    it('Teammate 不读 name 字段（避免拿 reviewer 名当 team 名）', () => {
      expect(
        extractTeamNameFromToolInput('Teammate', { name: 'reviewer-claude' }),
      ).toBeNull();
    });
  });

  describe('其他工具', () => {
    it.each([
      ['Bash', { command: 'ls' }],
      ['Read', { file_path: '/tmp/x' }],
      ['Edit', { file_path: '/tmp/x', old_string: 'a', new_string: 'b' }],
      ['UnknownTool', { team_name: 'X' }], // 不在白名单 → null
    ])('%s → null（不属于 team 工具白名单）', (toolName, input) => {
      expect(extractTeamNameFromToolInput(toolName, input)).toBeNull();
    });
  });

  describe('容错', () => {
    it.each([
      ['TeamCreate', null],
      ['TeamCreate', undefined],
      ['TeamCreate', 'string-input'],
      ['TeamCreate', 42],
      ['TeamCreate', { name: '' }], // 空字符串不算
      ['TeamCreate', { name: null }], // 非 string 不算
      ['TeamCreate', { name: 123 }],
      ['TeamCreate', {}],
    ])('%s + invalid %s → null', (toolName, input) => {
      expect(extractTeamNameFromToolInput(toolName, input)).toBeNull();
    });
  });
});
