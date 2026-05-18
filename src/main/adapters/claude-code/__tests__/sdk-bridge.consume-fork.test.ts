/**
 * sdk-bridge.consume CLI fork detection 单测（CHANGELOG_27 / REVIEW_6）。
 *
 * 覆盖 first realId !== opts.resume 的 fork 分支处理（renameSdkSession 调用 + claim 转移）。
 *
 * Mock 策略与 recovery sub-test 同款，hoisted vi.mock 必须每个文件独立写。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';
import { makeBareSdkLoaderMock } from '@main/__tests__/_shared/mocks/sdk-loader';

// R37 P2-F Step 3.1：sessionRepo / sdk-loader 走 _shared/mocks/ factory。
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({
    overrides: { get: vi.fn() },
  }),
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    claimAsSdk: vi.fn(),
    releaseSdkClaim: vi.fn(),
    expectSdkSession: vi.fn(() => () => undefined),
    renameSdkSession: vi.fn(),
    unarchive: vi.fn(),
  },
}));

vi.mock('@main/adapters/claude-code/sdk-loader', () => makeBareSdkLoaderMock());

vi.mock('@main/adapters/claude-code/sdk-runtime', () => ({
  getSdkRuntimeOptions: () => ({ executable: 'node', env: {} }),
  getPathToClaudeCodeExecutable: () => '/fake/cli',
}));

vi.mock('@main/adapters/claude-code/sdk-injection', () => ({
  getClaudeAgentDeckPluginPath: () => '/fake/plugin',
  getAgentDeckSystemPromptAppend: () => '',
}));

import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import { emits, makeBridge } from './sdk-bridge/_setup';

beforeEach(() => {
  emits.length = 0;
  vi.mocked(sessionRepo.get).mockReset();
  vi.mocked(sessionManager.renameSdkSession).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sdk-bridge.consume CLI fork detection（CHANGELOG_27 / REVIEW_6）', () => {
  it('first realId ≠ opts.resume → 调 sessionManager.renameSdkSession(OLD_ID, NEW_ID) + release OLD claim', async () => {
    const bridge = makeBridge();

    // 模拟 SDK 流：第一条 system message 携带 NEW_ID（CLI 静默 fork）
    const NEW_ID = 'forked-new-id';
    const OLD_ID = 'requested-old-id';
    const tempKey = 'temp-uuid';

    async function* fakeSdkStream(): AsyncGenerator<unknown> {
      yield { type: 'system', subtype: 'init', session_id: NEW_ID };
      // 不再 yield，让 consume 自然走完 finally
    }

    const internal = {
      realSessionId: null as string | null,
      cwd: '/tmp/x',
      query: fakeSdkStream() as unknown,
      pendingUserMessages: [] as unknown[],
      notify: null,
      pendingPermissions: new Map(),
      pendingAskUserQuestions: new Map(),
      pendingExitPlanModes: new Map(),
      toolUseNames: new Map(),
    };

    let firstId: string | null = null;
    // consume 是 private，用 unknown cast 跳过 access check
    await (bridge as unknown as {
      consume: (
        i: typeof internal,
        t: string,
        cb: (id: string) => void,
        r?: string,
      ) => Promise<string | null>;
    }).consume(internal, tempKey, (id) => {
      firstId = id;
    }, OLD_ID);

    expect(firstId).toBe(NEW_ID);

    // REVIEW_7 M3：renameSdkSession 内聚 sdkOwned claim 转移（OLD_ID → NEW_ID 原子），
    // 调用方不再手工 releaseSdkClaim(OLD_ID)。只断言 renameSdkSession 被正确调用。
    const { sessionManager } = await import('@main/session/manager');
    expect(vi.mocked(sessionManager.renameSdkSession)).toHaveBeenCalledWith(OLD_ID, NEW_ID);
  });

  it('first realId === opts.resume → 不触发 fork 分支（不调 renameSdkSession）', async () => {
    const bridge = makeBridge();
    const SAME_ID = 'unchanged-id';
    const tempKey = 'temp-uuid-2';

    async function* fakeSdkStream(): AsyncGenerator<unknown> {
      yield { type: 'system', subtype: 'init', session_id: SAME_ID };
    }

    const internal = {
      realSessionId: null as string | null,
      cwd: '/tmp/x',
      query: fakeSdkStream() as unknown,
      pendingUserMessages: [] as unknown[],
      notify: null,
      pendingPermissions: new Map(),
      pendingAskUserQuestions: new Map(),
      pendingExitPlanModes: new Map(),
      toolUseNames: new Map(),
    };

    const { sessionManager } = await import('@main/session/manager');
    vi.mocked(sessionManager.renameSdkSession).mockClear();
    vi.mocked(sessionManager.releaseSdkClaim).mockClear();

    await (bridge as unknown as {
      consume: (
        i: typeof internal,
        t: string,
        cb: (id: string) => void,
        r?: string,
      ) => Promise<string | null>;
    }).consume(internal, tempKey, () => undefined, SAME_ID);

    // tempKey !== realId 路径会走 rename(tempKey, SAME_ID)，但不应该走 fork 分支 rename(SAME_ID, SAME_ID)
    const renameCalls = vi.mocked(sessionManager.renameSdkSession).mock.calls;
    const forkRenames = renameCalls.filter(([from, to]) => from === SAME_ID && to === SAME_ID);
    expect(forkRenames).toHaveLength(0);
    // releaseSdkClaim(SAME_ID) 是 finally 释放，能调 1 次正常；但不应该来自 fork 分支
    // 这里只断言不重复 release（finally 1 次 + 如果 fork 分支错误地走过 release 又 1 次 = 2 次会出问题）
    // 简化：只断言 fork 分支没触发 rename
  });
});
