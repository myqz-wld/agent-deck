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
    updateCliSessionId: vi.fn(),
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
      // **plan reverse-rename-sid-stability-20260520 §A.4-pre S2 字段命名升级**:
      // realSessionId → cliSessionId + 新增 applicationSid 双字段
      applicationSid: OLD_ID,
      cliSessionId: null as string | null,
      cwd: '/tmp/x',
      query: fakeSdkStream() as unknown,
      pendingUserMessages: [] as unknown[],
      notify: null,
      pendingPermissions: new Map(),
      pendingAskUserQuestions: new Map(),
      pendingExitPlanModes: new Map(),
      toolUseNames: new Map(),
      pendingFileChangeIntents: new Map(),
      seenUsageMessageIds: new Map(),
      turnUsageByBucket: new Map(),
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

    // **plan reverse-rename-sid-stability-20260520 §A.4-pre S6 反向 rename 修订**:
    // fork detect 走 sessionManager.updateCliSessionId(applicationSid, NEW_ID) 替代 renameSdkSession;
    // 第一参数 applicationSid (= OLD_ID for resume path),走 manager 黑名单链确保 OLD_CLI_ID
    // 进 recentlyDeleted 60s 防迟到 hook event 复活幽灵 record (不变量 5)。
    const { sessionManager } = await import('@main/session/manager');
    expect(vi.mocked(sessionManager.updateCliSessionId)).toHaveBeenCalledWith(internal.applicationSid, NEW_ID);
    // 旧 renameSdkSession 不再因 fork 调用 (反向 rename 不动 sessions.id)
    const renameCalls = vi.mocked(sessionManager.renameSdkSession).mock.calls;
    const forkRenames = renameCalls.filter(([from, to]) => from === OLD_ID && to === NEW_ID);
    expect(forkRenames).toHaveLength(0);
  });

  it('first realId === opts.resume → 不触发 fork 分支（不调 renameSdkSession）', async () => {
    const bridge = makeBridge();
    const SAME_ID = 'unchanged-id';
    const tempKey = 'temp-uuid-2';

    async function* fakeSdkStream(): AsyncGenerator<unknown> {
      yield { type: 'system', subtype: 'init', session_id: SAME_ID };
    }

    const internal = {
      applicationSid: SAME_ID,
      cliSessionId: null as string | null,
      cwd: '/tmp/x',
      query: fakeSdkStream() as unknown,
      pendingUserMessages: [] as unknown[],
      notify: null,
      pendingPermissions: new Map(),
      pendingAskUserQuestions: new Map(),
      pendingExitPlanModes: new Map(),
      toolUseNames: new Map(),
      pendingFileChangeIntents: new Map(),
      seenUsageMessageIds: new Map(),
      turnUsageByBucket: new Map(),
    };

    const { sessionManager } = await import('@main/session/manager');
    vi.mocked(sessionManager.renameSdkSession).mockClear();
    vi.mocked(sessionManager.updateCliSessionId).mockClear();
    vi.mocked(sessionManager.releaseSdkClaim).mockClear();

    await (bridge as unknown as {
      consume: (
        i: typeof internal,
        t: string,
        cb: (id: string) => void,
        r?: string,
      ) => Promise<string | null>;
    }).consume(internal, tempKey, () => undefined, SAME_ID);

    // first realId === SAME_ID === resumeId → 不应触发 fork 分支
    // (反向 rename 修订:fork detect 走 sessionManager.updateCliSessionId 不再 renameSdkSession)
    expect(vi.mocked(sessionManager.updateCliSessionId)).not.toHaveBeenCalled();
    // 旧 renameSdkSession 也不应被 fork 分支调用 (但 spawn 路径 tempKey → realId rename 仍会调,
    // 这里只 filter 验证 fork 分支字面 rename(SAME_ID, SAME_ID))
    const renameCalls = vi.mocked(sessionManager.renameSdkSession).mock.calls;
    const forkRenames = renameCalls.filter(([from, to]) => from === SAME_ID && to === SAME_ID);
    expect(forkRenames).toHaveLength(0);
  });
});
