/**
 * SessionManager 单测共享 setup（CHANGELOG_52 / 第三轮大文件拆分 Step 1；R37 P2-F Step 3.1 转 re-export）。
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
 *
 * **R37 P2-F Step 3.1 转 re-export**：
 * `makeSessionRepoMock` / `makeEventBusMock` / `makeAgentDeckTeamRepoMock` 移到
 * `src/main/__tests__/_shared/mocks/` 让其他 test 也能复用。本文件包一层把 mockSessions /
 * mockEmits 作为 external state 注入 shared factory，3 个 manager test 调用方签名不变。
 * `makeEventRepoMock` / `makeFileChangeRepoMock` 保留本地（manager 系列独占，未达「3+ 文件复用」
 * 阈值不抽到 _shared）。
 */
import { vi } from 'vitest';
import type { AgentEvent, SessionRecord } from '@shared/types';
import { makeSessionRepoMock as makeSessionRepoMockBase } from '@main/__tests__/_shared/mocks/session-repo';
import { makeEventBusMock as makeEventBusMockBase } from '@main/__tests__/_shared/mocks/event-bus';

export {
  makeAgentDeckTeamRepoMock,
} from '@main/__tests__/_shared/mocks/agent-deck-team-repo';

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
  over: Partial<AgentEvent> & { source?: 'sdk' | 'hook'; hookOrigin?: 'sdk' | 'cli' },
): AgentEvent {
  return {
    sessionId: over.sessionId ?? 'sess-default',
    agentId: over.agentId ?? 'claude-code',
    kind: over.kind ?? 'session-start',
    payload: over.payload ?? { cwd: '/tmp' },
    ts: over.ts ?? Date.now(),
    source: over.source,
    hookOrigin: over.hookOrigin,
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

/**
 * 包一层 shared factory，注入 module-level mockSessions Map 作为 external state container。
 * 3 个 manager test 调用方签名 `makeSessionRepoMock()` 保持不变（hoist 约束 + zero-arg API）。
 */
export function makeSessionRepoMock(): Record<string, unknown> {
  return makeSessionRepoMockBase({ sessions: mockSessions });
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

/**
 * 包一层 shared factory，注入 module-level mockEmits 数组作为 external state container。
 */
export function makeEventBusMock(): Record<string, unknown> {
  return makeEventBusMockBase({ emits: mockEmits });
}
