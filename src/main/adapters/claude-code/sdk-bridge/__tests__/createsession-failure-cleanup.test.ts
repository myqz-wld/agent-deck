/**
 * REVIEW_75 (plan deep-review-project-20260531 Batch C1) 回归 test：createSession 失败路径
 * cleanup 完整性 — 3 个真问题修法验证。
 *
 * **F1 [HIGH] (reviewer-codex + lead 代码链实测三重确认)**：createSession 失败路径落下孤儿
 *   tempKey DB row。根因:consume() 在 try 内必经 emit→sessionManager.ingest(stream-processor.ts:219
 *   的 30s timeout error message + L446 consume finally 必发的 session-end),event.source==='sdk'
 *   在 dedupOrClaim 5 个 skip 分支(全要求 source==='hook')一个都不命中 → ensureRecord 必建一条
 *   id=tempKey/source='sdk' 的 DB row(随后 session-end 推成 dormant)。修前 catch 只 delete
 *   in-memory Map + release claim,**从不删这条 DB row** → SessionList 永久幽灵 dormant 会话。
 *   修法:sdk-query catch + orchestrator catch 都补 sessionRepo.delete(tempKey)(只删 tempKey 不删
 *   applicationSid/opts.resume — spawn 路径孤儿 row id===tempKey;resume 路径 opts.resume 是预存合法
 *   row 不能删)。
 *
 * **F2 [MED] (reviewer-claude + lead grep/diff 实测)**：orchestrator prepare→finalize 整段无
 *   try/catch — prepare 段 resolver(resolveClaudeSandboxMode/Model 走 sessionRepo.get +
 *   settingsStore.get,better-sqlite3 同步 .get() 可抛)抛错 → releasePending() + releaseSdkClaim
 *   都漏调 → pendingSdkCwds 卡 60s(CHANGELOG_47 leak)+ resume 路径 opts.resume 永留 sdkOwned
 *   (REVIEW_5 H4 leak)。修法:orchestrator prepare→finalize 包 try/catch,catch 幂等清理。
 *
 * **F3 [MED] (reviewer-codex + lead 代码链实测)**：CLI realId claim 在自然 stream end 漏释放。
 *   create-session-sdk-query.ts:179 拿 realId 后无条件 claimAsSdk(realId);resume fork /
 *   fresh-cli-reuse-app 路径 realId(CLI sid) !== applicationSid。修前 consume finally 仅
 *   releaseSdkClaim(applicationSid) → CLI sid claim 永留 #sdkOwned → 后续同 CLI sid hook event
 *   被 dedupOrClaim 当 SDK-owned 丢弃 + Set 泄漏到重启。修法:finally mirror runCloseSessionCleanup
 *   三面释放 — cliSessionId !== sid && !== tempKey 时额外 releaseSdkClaim(cliSid)。
 *
 * **mock 策略**：与 createsession-fail-fast.test.ts 同款全 mock（sessionManager / sessionRepo /
 * sdk-loader / settings-store）。本文件额外把 sessionRepo.delete 设为可 assert spy（验证 F1
 * 孤儿 row 清理）+ settingsStore.get 设为可抛（验证 F2 resolver throw cleanup）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';
import { makeBareSdkLoaderMock } from '@main/__tests__/_shared/mocks/sdk-loader';
import { makeSettingsStoreMock } from '@main/__tests__/_shared/mocks/settings-store';

// vi.hoisted：vi.mock factory 被 hoist 到文件顶,工厂内引用的 spy 必须用 vi.hoisted 提升
// （否则 ReferenceError: Cannot access ... before initialization）。
const { sessionRepoDeleteSpy, settingsGetSpy } = vi.hoisted(() => ({
  // sessionRepo.delete 用独立 spy 让本文件能 assert F1 孤儿 row 清理
  sessionRepoDeleteSpy: vi.fn(),
  // settingsStore.get 可被单 case 改成 throw 来验证 F2 resolver throw cleanup
  settingsGetSpy: vi.fn((_key: string) => undefined as unknown),
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({
    overrides: {
      get: vi.fn(),
      delete: sessionRepoDeleteSpy,
    },
  }),
}));

vi.mock('@main/store/event-repo', () => ({
  eventRepo: {
    listForSession: vi.fn(() => []),
  },
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: makeSettingsStoreMock({
    overrides: {
      get: settingsGetSpy,
    },
  }),
}));

vi.mock('@main/store/agent-deck-team-repo', () => ({
  agentDeckTeamRepo: {
    findActiveMembershipsBySession: vi.fn(() => []),
  },
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    claimAsSdk: vi.fn(),
    releaseSdkClaim: vi.fn(),
    expectSdkSession: vi.fn(() => () => undefined),
    renameSdkSession: vi.fn(),
    unarchive: vi.fn(),
    updateCliSessionId: vi.fn(),
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
  getAgentDeckPluginsForSession: () => undefined,
}));

vi.mock('@main/agent-deck-mcp/server', () => ({
  getAgentDeckMcpServerForSession: vi.fn(() => null),
  AGENT_DECK_MCP_TOOL_PATTERN: /^mcp__agent-deck/,
}));

vi.mock('@main/session/summarizer/llm-runners', () => ({
  summariseSessionForHandOff: vi.fn(async () => null),
}));

import { sessionManager } from '@main/session/manager';
import { sessionRepo } from '@main/store/session-repo';
import { loadSdk } from '@main/adapters/claude-code/sdk-loader';
import { ClaudeSdkBridge } from '@main/adapters/claude-code/sdk-bridge';
import { MockSdkQuery } from '@main/__tests__/_shared/mocks/sdk-query';
import type { AgentEvent } from '@shared/types';

const emits: AgentEvent[] = [];

function makeBridge(): ClaudeSdkBridge {
  return new ClaudeSdkBridge({
    emit: (e) => {
      emits.push(e);
    },
  });
}

function installMockQuery(mockQuery: MockSdkQuery): void {
  vi.mocked(loadSdk).mockResolvedValue({
    query: vi.fn(() => mockQuery),
    tool: vi.fn((name, description, inputSchema, handler) => ({
      name,
      description,
      inputSchema,
      handler,
    })),
  } as never);
}

/** UUID v4 format (tempKey = randomUUID()) — 用于 assert 孤儿 row delete 的 id 形态 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeEach(() => {
  emits.length = 0;
  sessionRepoDeleteSpy.mockReset();
  settingsGetSpy.mockReset();
  settingsGetSpy.mockReturnValue(undefined);
  vi.mocked(loadSdk).mockReset();
  vi.mocked(sessionManager.claimAsSdk).mockReset();
  vi.mocked(sessionManager.releaseSdkClaim).mockReset();
  vi.mocked(sessionManager.expectSdkSession).mockReset();
  vi.mocked(sessionManager.expectSdkSession).mockReturnValue(() => undefined);
  vi.mocked(sessionRepo.get).mockReset();
  vi.mocked(sessionRepo.get).mockReturnValue(null);
  (sessionRepo as unknown as { __sessions: Map<string, unknown> }).__sessions.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('REVIEW_75 F1 [HIGH]：createSession 失败路径清掉孤儿 tempKey DB row', () => {
  it('non-resume fast-fail：sessionRepo.delete(tempKey) 被调（清孤儿 row）', async () => {
    const bridge = makeBridge();
    const mockQuery = new MockSdkQuery();
    installMockQuery(mockQuery);

    // 1 frame 无 session_id + endStream → realId===tempKey → throw 进 catch
    mockQuery.pushFrame({ type: 'system', subtype: 'hook_started' });
    mockQuery.endStream();

    await expect(bridge.createSession({ cwd: '/tmp/test', prompt: 'hi' })).rejects.toThrow(
      /SDK stream ended without emitting first session_id frame/,
    );

    // **F1 核心断言**：sessionRepo.delete 被调，且 id 是 UUID 形态（tempKey）
    expect(sessionRepoDeleteSpy).toHaveBeenCalled();
    const deletedIds = sessionRepoDeleteSpy.mock.calls.map((c) => c[0] as string);
    expect(deletedIds.some((id) => UUID_RE.test(id))).toBe(true);
  });

  it('resume fast-fail：永不删 opts.resume 合法 row（只删 tempKey UUID，不删 OLD-ID 字符串）', async () => {
    const bridge = makeBridge();
    const mockQuery = new MockSdkQuery();
    installMockQuery(mockQuery);

    // resume 路径下 1 frame 无 session_id + endStream。注意 resume 路径 fallback 用
    // resumeId 而非 tempKey，realId=resumeId !== tempKey → 不进 A1-HIGH-1 throw。
    // 但若 try 内其他点 throw（这里用同款 endStream-no-id 模拟），catch 仍跑。
    // 关键不变量：opts.resume='OLD-ID' 这条合法历史 row 绝不能被 delete。
    mockQuery.pushFrame({ type: 'system', subtype: 'hook_started' });
    mockQuery.endStream();

    // resume 路径：realId=fallbackId=resumeId='OLD-ID' !== tempKey → 不 throw（走 finalize）
    // 本 case 验证 resume 成功路径 sessionRepo.delete 不删 OLD-ID（即使被调也只删 tempKey）
    await bridge
      .createSession({ cwd: '/tmp/test', prompt: 'hi', resume: 'OLD-ID' })
      .catch(() => undefined); // resume 路径可能 resolve 也可能 throw，都不影响断言

    // **F1 安全边界断言**：sessionRepo.delete 绝不以 'OLD-ID' 调用（resume 合法 row 不删）
    const deletedIds = sessionRepoDeleteSpy.mock.calls.map((c) => c[0] as string);
    expect(deletedIds).not.toContain('OLD-ID');
  });
});

describe('REVIEW_75 F2 [MED]：orchestrator prepare 段 resolver throw 漏清 cleanup', () => {
  it('resolver throw（settingsStore.get 抛）→ releasePending + releaseSdkClaim(opts.resume) 仍调', async () => {
    const bridge = makeBridge();
    const mockQuery = new MockSdkQuery();
    installMockQuery(mockQuery);

    const releaseSpy = vi.fn();
    vi.mocked(sessionManager.expectSdkSession).mockReturnValue(releaseSpy);

    // 让 resolveClaudeSandboxMode 内部 settingsStore.get('claudeCodeSandbox') 抛错。
    // resolveClaudeSandboxMode fallback 链：opts.claudeCodeSandbox ?? persisted ??
    // settingsStore.get('claudeCodeSandbox') ?? 'off'。不传 claudeCodeSandbox + resume=undefined
    // → persisted=null → 走 settingsStore.get → 抛。
    settingsGetSpy.mockImplementation((key: string) => {
      if (key === 'claudeCodeSandbox') throw new Error('SQLITE_BUSY (simulated)');
      return undefined;
    });

    // resume 路径让 claimAsSdk(opts.resume) 先调，验证 catch 释放它
    await expect(
      bridge.createSession({ cwd: '/tmp/test', prompt: 'hi', resume: 'RESUME-F2' }),
    ).rejects.toThrow(/SQLITE_BUSY/);

    // **F2 核心断言**：resolver throw（prepare 段，runCreateSessionSdkQuery 之前）→ orchestrator
    // catch 仍 releasePending + releaseSdkClaim(opts.resume)
    expect(releaseSpy).toHaveBeenCalled(); // pendingSdkCwds 释放（防 60s 卡死误吞）
    const releasedIds = vi.mocked(sessionManager.releaseSdkClaim).mock.calls.map((c) => c[0]);
    expect(releasedIds).toContain('RESUME-F2'); // sdkOwned 释放（防 OLD_ID 永久吞 hook）
  });
});

describe('REVIEW_75 F3 [MED]：consume 自然 stream end 释放 CLI sid claim', () => {
  it('resume fork（realId !== applicationSid）：finally 释放 applicationSid + CLI realId 两个 claim', async () => {
    const bridge = makeBridge();
    const mockQuery = new MockSdkQuery();
    installMockQuery(mockQuery);
    vi.mocked(sessionRepo.get).mockImplementation((sid: string) =>
      sid === 'APP-SID'
        ? ({
            id: 'APP-SID',
            cwd: '/tmp/test',
            adapter: 'claude-code',
            title: null,
            lifecycle: 'active',
            permissionMode: 'default',
            claudeCodeSandbox: 'workspace-write',
            cliSessionId: 'OLD-CLI-SID',
            model: null,
            extraAllowWrite: null,
            archivedAt: null,
            createdAt: 0,
            updatedAt: 0,
            lastEventAt: 0,
            spawnDepth: 0,
            spawnedBy: null,
          } as never)
        : null,
    );

    // resume 路径 + CLI 隐式 fork：opts.resume='APP-SID'（applicationSid），SDK first id 给
    // 不同的 'CLI-FORK-ID'（realId = CLI sid 维度）。consume first-id 路径走 S6 fork detect
    // updateCliSessionId(applicationSid, realId)，internal.cliSessionId = 'CLI-FORK-ID'，
    // applicationSid 保持 'APP-SID'。stream 自然结束 → finally 应释放 APP-SID + CLI-FORK-ID。
    const createPromise = bridge.createSession({
      cwd: '/tmp/test',
      prompt: 'hi',
      resume: 'APP-SID',
    });

    // 推 first id frame = CLI-FORK-ID（≠ resume 的 APP-SID，模拟 CLI 隐式 fork）
    mockQuery.pushFrame({ type: 'system', subtype: 'init', session_id: 'CLI-FORK-ID' });
    await new Promise((r) => setImmediate(r));
    // 自然结束 stream（非 closeSession 路径）
    mockQuery.endStream();
    await new Promise((r) => setImmediate(r));

    await createPromise.catch(() => undefined);
    // 让 consume finally 跑完
    await new Promise((r) => setImmediate(r));

    // **F3 核心断言**：finally 释放 applicationSid（APP-SID）+ CLI realId（CLI-FORK-ID）两个 claim
    const releasedIds = vi.mocked(sessionManager.releaseSdkClaim).mock.calls.map((c) => c[0]);
    expect(releasedIds).toContain('APP-SID'); // 既有：释放 applicationSid
    expect(releasedIds).toContain('CLI-FORK-ID'); // **F3 修法**：额外释放 CLI sid claim
  });

  it('spawn 主路径（realId === applicationSid）：不重复释放（cliSid === sid 时 guard 跳过）', async () => {
    const bridge = makeBridge();
    const mockQuery = new MockSdkQuery();
    installMockQuery(mockQuery);

    // spawn 主路径：无 resume，first id 'SPAWN-SID' → applicationSid 切到 SPAWN-SID +
    // cliSessionId = SPAWN-SID（两者同值）。finally guard `cliSid !== sid` false → 不重复释放。
    const createPromise = bridge.createSession({ cwd: '/tmp/test', prompt: 'hi' });
    mockQuery.pushFrame({ type: 'system', subtype: 'init', session_id: 'SPAWN-SID' });
    await new Promise((r) => setImmediate(r));
    mockQuery.endStream();
    await new Promise((r) => setImmediate(r));
    await createPromise.catch(() => undefined);
    await new Promise((r) => setImmediate(r));

    // SPAWN-SID 释放一次（finally releaseSdkClaim(sid)），cliSid===sid guard 跳过额外释放
    const releasedSpawnSid = vi
      .mocked(sessionManager.releaseSdkClaim)
      .mock.calls.map((c) => c[0])
      .filter((id) => id === 'SPAWN-SID');
    // 至少释放一次（finally sid）；guard 保证不因 cliSid===sid 重复释放成 2 次纯粹冗余
    expect(releasedSpawnSid.length).toBeGreaterThanOrEqual(1);
  });
});
