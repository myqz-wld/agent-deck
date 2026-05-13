/**
 * SessionManager 单测共享 setup（CHANGELOG_52 / 第三轮大文件拆分 Step 1）。
 *
 * 由 `manager-ingest.test.ts` / `manager-public-api.test.ts` / `manager-delete.test.ts`
 * 三个文件共用 mock Map 引用 + makeEvent helper + resetMocks。
 *
 * **vi.mock 不能放这里**：vi.mock 会被 vitest 在「调用方文件」顶部 hoist，跨文件 import
 * 不会被 hoist。所以每个 test 文件顶部都要重复一份 `vi.mock(...)` 4 段（factory 内引用
 * 本文件 export 的 Map）—— 这是 vitest 的固有约束，参考拆分前 manager.test.ts:94 注释。
 *
 * **factory 内引用 import 的 const 是安全的**：vi.mock factory 是 lazy execution，
 * 实际只在 mocked 模块第一次被加载时被调用，那时所有 import 都已经解析完毕。
 */
import { vi } from 'vitest';
import type { AgentEvent, SessionRecord } from '@shared/types';

// ─────────────────────────────────────────────────────────────────────────────
// 模块级 mock 状态（每个 test 在 beforeEach 通过 resetMocks 重置）
// ─────────────────────────────────────────────────────────────────────────────

export const mockSessions = new Map<string, SessionRecord>();
export const mockEvents: AgentEvent[] = [];
export const mockFileChanges: unknown[] = [];
export const mockEmits: { name: string; payload: unknown }[] = [];

// ─────────────────────────────────────────────────────────────────────────────
// makeEvent helper
// ─────────────────────────────────────────────────────────────────────────────

export function makeEvent(
  over: Partial<AgentEvent> & { source?: 'sdk' | 'hook' },
): AgentEvent {
  return {
    sessionId: over.sessionId ?? 'sess-default',
    agentId: over.agentId ?? 'claude-code',
    kind: over.kind ?? 'session-start',
    payload: over.payload ?? { cwd: '/tmp' },
    ts: over.ts ?? Date.now(),
    source: over.source,
  } as AgentEvent;
}

// ─────────────────────────────────────────────────────────────────────────────
// 各 test 在 beforeEach 调用：清 Map + release SessionManager 内部 sdkOwned 残留
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 测试用过的 sessionId 全集（不同 describe 用过的都列在这里）：
 * 安全起见每次 beforeEach 都全部 release，避免上一个 test 漏 release 污染下一个。
 * pendingSdkCwds 走 expectSdkSession 反向不可达，但每次测试都是独立 cwd 不会互相影响。
 */
const COMMON_SESSION_IDS = [
  'sess-1',
  'sess-2',
  'sess-3',
  'sess-hook-first',
  'sess-sdk-claim',
  'sess-after-claim',
  'sess-existing',
  'OLD_ID',
  'NEW_ID',
  'sess-archive',
  'sess-unarchive',
  'sess-reactivate',
  'sess-del-1',
  'sess-ghost',
  'sess-ghost-hook',
];

export async function resetMocks(): Promise<void> {
  mockSessions.clear();
  mockEvents.length = 0;
  mockFileChanges.length = 0;
  mockEmits.length = 0;

  // 动态 import 拿 sessionManager（vi.mock 已 hoist，import 在这里安全）
  const { sessionManager } = await import('@main/session/manager');
  for (const id of COMMON_SESSION_IDS) {
    sessionManager.releaseSdkClaim(id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 标准 vi.mock factory bodies（每个 test 文件顶部 vi.mock 调用直接复用）
//
// 用法：每个 test 文件顶部
//   vi.mock('@main/store/session-repo', () => ({ sessionRepo: makeSessionRepoMock() }));
//   vi.mock('@main/store/event-repo', () => ({ eventRepo: makeEventRepoMock() }));
//   vi.mock('@main/store/file-change-repo', () => ({ fileChangeRepo: makeFileChangeRepoMock() }));
//   vi.mock('@main/event-bus', () => ({ eventBus: makeEventBusMock() }));
//
// 这样 4 段 vi.mock 调用必须各 test 文件重复一遍（hoist 约束），但 factory 体复用本 setup。
// ─────────────────────────────────────────────────────────────────────────────

export function makeSessionRepoMock(): {
  get: (id: string) => SessionRecord | null;
  upsert: (rec: SessionRecord) => void;
  setActivity: (id: string, activity: SessionRecord['activity'], ts: number) => void;
  setLifecycle: (id: string, lifecycle: SessionRecord['lifecycle'], ts: number) => void;
  setArchived: (id: string, ts: number | null) => void;
  setPermissionMode: ReturnType<typeof vi.fn>;
  delete: (id: string) => void;
  listActiveAndDormant: () => SessionRecord[];
  listHistory: () => SessionRecord[];
  rename: ReturnType<typeof vi.fn>;
} {
  return {
    get: (id) => mockSessions.get(id) ?? null,
    upsert: (rec) => {
      mockSessions.set(rec.id, rec);
    },
    setActivity: (id, activity, ts) => {
      const r = mockSessions.get(id);
      if (r) mockSessions.set(id, { ...r, activity, lastEventAt: ts });
    },
    setLifecycle: (id, lifecycle, ts) => {
      const r = mockSessions.get(id);
      if (r) {
        mockSessions.set(id, {
          ...r,
          lifecycle,
          endedAt: lifecycle === 'closed' ? ts : null,
        });
      }
    },
    setArchived: (id, ts) => {
      const r = mockSessions.get(id);
      if (r) mockSessions.set(id, { ...r, archivedAt: ts });
    },
    setPermissionMode: vi.fn(),
    delete: (id) => {
      mockSessions.delete(id);
    },
    listActiveAndDormant: () =>
      [...mockSessions.values()].filter(
        (s) => s.lifecycle !== 'closed' && s.archivedAt === null,
      ),
    listHistory: () => [],
    rename: vi.fn(),
  };
}

export function makeEventRepoMock(): {
  insert: (e: AgentEvent) => number;
  listForSession: () => AgentEvent[];
  countForSession: () => number;
  findLatestAssistantMessage: () => null;
  deleteForSession: ReturnType<typeof vi.fn>;
  hasToolUseStartWithFilePath: () => boolean;
} {
  return {
    insert: (e) => {
      mockEvents.push(e);
      return mockEvents.length;
    },
    listForSession: () => [],
    countForSession: () => 0,
    findLatestAssistantMessage: () => null,
    deleteForSession: vi.fn(),
    hasToolUseStartWithFilePath: () => false,
  };
}

export function makeFileChangeRepoMock(): {
  insert: (rec: unknown) => number;
  listForSession: () => unknown[];
  countForSession: () => number;
} {
  return {
    insert: (rec) => {
      mockFileChanges.push(rec);
      return mockFileChanges.length;
    },
    listForSession: () => [],
    countForSession: () => 0,
  };
}

export function makeEventBusMock(): {
  emit: (name: string, payload: unknown) => void;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
} {
  return {
    emit: (name, payload) => {
      mockEmits.push({ name, payload });
    },
    on: vi.fn(),
    off: vi.fn(),
  };
}

/**
 * REVIEW_31 测试修复：sessionManager.list / delete / markClosed / close 路径会调
 * agent-deck-team-repo 的 enrichWithTeamsBatch / findActiveMembershipsBySession /
 * findActiveMembershipsBySessionIds（v014 universal team backend 接入），三个 manager
 * test 文件原本只 mock 了 sessionRepo / eventRepo / fileChangeRepo / eventBus，所以这些
 * 路径走真 `defaultRepo() → getDb()` 时挂在「Database not initialized」。
 *
 * 本 mock 的所有方法都返回「无 team membership」结果（空数组 / null / 0），对 archive /
 * unarchive / reactivate / delete / ingest 主路径测试无语义影响 —— 那些测试不验证 team
 * 联动逻辑（已由 tools.test.ts / agent-deck-repos.test.ts 覆盖）。
 *
 * 用法（每个 test 文件顶部加）：
 *   vi.mock('@main/store/agent-deck-team-repo', () => ({
 *     agentDeckTeamRepo: makeAgentDeckTeamRepoMock(),
 *     TeamInvariantError: class extends Error {},  // sessionManager.delete 路径 catch 时引用
 *   }));
 */
export function makeAgentDeckTeamRepoMock(): {
  findActiveMembershipsBySession: () => never[];
  findActiveMembershipsBySessionIds: () => Map<string, never[]>;
  leaveTeam: () => null;
  countActiveLeads: () => number;
  archive: () => null;
} {
  return {
    findActiveMembershipsBySession: () => [],
    findActiveMembershipsBySessionIds: () => new Map(),
    leaveTeam: () => null,
    countActiveLeads: () => 0,
    archive: () => null,
  };
}
