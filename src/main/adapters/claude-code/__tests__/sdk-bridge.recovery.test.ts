/**
 * sdk-bridge.recoverAndSend 单测（CHANGELOG_26 / B 方案）。
 *
 * 覆盖：sendMessage 检测 sessions Map 没有该 sessionId 时的「断连自愈」路径。
 * 重点验证两 Agent 对抗指出的硬约束：
 *   - 单飞（同 sessionId 并发只调一次 createSession）
 *   - 占位 message emit（30s fallback 期间不让 UI 哑巴 busy）
 *   - record 不存在 → 抛与原行为一致的 'not found'
 *   - 失败时补 error message emit
 *
 * Mock 策略（与 consume-fork sub-test 同款，hoisted vi.mock 必须每个文件独立写）：
 *   - sessionRepo / sessionManager / sdk-loader / sdk-runtime / sdk-injection 全 mock
 *   - 子类化 ClaudeSdkBridge 覆盖 createSession 不真起 SDK CLI 子进程，
 *     避免本机 vitest 跑测试时 spawn 真 claude binary
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';
import { makeBareSdkLoaderMock } from '@main/__tests__/_shared/mocks/sdk-loader';
import { makeSettingsStoreMock } from '@main/__tests__/_shared/mocks/settings-store';

// R37 P2-F Step 3.1：sessionRepo / sdk-loader / settings-store 走 _shared/mocks/ factory；
// sessionRepo.get 用 vi.fn override 让 caller 在 beforeEach mockReset / mockReturnValue 切换 fixture。
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({
    overrides: { get: vi.fn() },
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
      get: vi.fn((key: string) => {
        if (key === 'autoSummariseOnFallback') return true;
        return undefined;
      }),
    },
  }),
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
}));

import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import { eventRepo } from '@main/store/event-repo';
import { settingsStore } from '@main/store/settings-store';
import { emits, makeBridge } from './sdk-bridge/_setup';

beforeEach(() => {
  emits.length = 0;
  vi.mocked(sessionRepo.get).mockReset();
  // CHANGELOG_99 R1 fix LOW-8 配套:reset renameSdkSession 让 cwdFellBack rename 断言准确
  vi.mocked(sessionManager.renameSdkSession).mockReset();
  // CHANGELOG_107 Step 6 配套:reset event-repo / settings-store mock 让 case 间隔离
  vi.mocked(eventRepo.listForSession).mockReset();
  vi.mocked(eventRepo.listForSession).mockReturnValue([]);
  vi.mocked(settingsStore.get).mockReset();
  vi.mocked(settingsStore.get).mockImplementation(((key: unknown) => {
    if (key === 'autoSummariseOnFallback') return true;
    return undefined;
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sdk-bridge.sendMessage 断连自愈（B 方案）', () => {
  it('record 在 → 走 createSession({resume,prompt,cwd,permissionMode}) + emit 占位 message', async () => {
    const bridge = makeBridge();
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-1',
      agentId: 'claude-code',
      cwd: '/tmp/work',
      title: 'work',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      permissionMode: 'plan',
    });

    await bridge.sendMessage('sess-1', 'hi');

    // 占位 message（非 error）emit 一条
    const placeholders = emits.filter(
      (e) =>
        e.kind === 'message' &&
        typeof (e.payload as { text?: string }).text === 'string' &&
        (e.payload as { text: string }).text.includes('正在自动恢复'),
    );
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0].sessionId).toBe('sess-1');
    expect((placeholders[0].payload as { error?: boolean }).error).toBeFalsy();

    // createSession 被调一次，参数完整复用 record
    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0]).toEqual({
      cwd: '/tmp/work',
      prompt: 'hi',
      resume: 'sess-1',
      permissionMode: 'plan',
      // REVIEW_36 HIGH-1: 正常 resume 路径也透传（fixture 中 record 没设字段，undefined）
      claudeCodeSandbox: undefined,
    });
  });

  it('record 不在 → 抛与原行为一致的 not found 错，createSession 不被调', async () => {
    const bridge = makeBridge();
    vi.mocked(sessionRepo.get).mockReturnValue(null);

    await expect(bridge.sendMessage('sess-ghost', 'hi')).rejects.toThrow(/not found/);
    expect(bridge.createCalls).toHaveLength(0);
    // 也不应该 emit 占位 message（没记录 = 真不可恢复，不要污染活动流）
    const placeholders = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('正在自动恢复'),
    );
    expect(placeholders).toHaveLength(0);
  });

  it('单飞：同 sessionId 并发 sendMessage 只触发一次 createSession', async () => {
    const bridge = makeBridge();
    bridge.createBehavior = 'block';
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-2',
      agentId: 'claude-code',
      cwd: '/tmp/x',
      title: 'x',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      permissionMode: null,
    });

    // 第一波（不 await）+ 让 inflight Promise 注册到 recovering Map
    const p1 = bridge.sendMessage('sess-2', 'first').catch(() => undefined);
    // microtask flush，确保 p1 已经把 inflight 写入 recovering Map
    await Promise.resolve();
    await Promise.resolve();
    // 第二波同 sessionId
    const p2 = bridge.sendMessage('sess-2', 'second').catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    // createSession 此刻只被调过一次（第二条等同一 inflight）
    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0].prompt).toBe('first');

    // 解锁 inflight，让两条 promise 都退出
    bridge.unblock?.();
    bridge.createBehavior = 'reject'; // 第二条递归 sendMessage 时再次走 recovery → 抛错让它早退
    bridge.rejectWith = new Error('second wave fast-fail');
    await p1;
    await p2;
  });

  it('createSession 失败 → 补 emit 一条 error message 后 throw', async () => {
    const bridge = makeBridge();
    bridge.createBehavior = 'reject';
    bridge.rejectWith = new Error('CLI auth expired');
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-3',
      agentId: 'claude-code',
      cwd: '/tmp/y',
      title: 'y',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      permissionMode: null,
    });

    await expect(bridge.sendMessage('sess-3', 'hi')).rejects.toThrow(/CLI auth expired/);

    // emit 序列：占位 message + error message
    const errorMsgs = emits.filter(
      (e) =>
        e.kind === 'message' &&
        ((e.payload as { error?: boolean }).error === true) &&
        ((e.payload as { text?: string }).text ?? '').includes('自动恢复失败'),
    );
    expect(errorMsgs).toHaveLength(1);
    expect(errorMsgs[0].sessionId).toBe('sess-3');
  });

  it('jsonl 不存在 → fallback 走不带 resume 的 createSession（CHANGELOG_28）', async () => {
    const bridge = makeBridge();
    bridge.jsonlExistsOverride = false; // 模拟 ~/.claude/projects/<cwd>/<sid>.jsonl 不在
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-no-jsonl',
      agentId: 'claude-code',
      cwd: '/tmp/abandoned',
      title: 'abandoned',
      source: 'sdk',
      lifecycle: 'closed',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: 3,
      archivedAt: null,
      permissionMode: 'acceptEdits',
    });

    await bridge.sendMessage('sess-no-jsonl', 'hi');

    // **plan reverse-rename-sid-stability-20260520 §A.4-pre S8 修订**:
    // createSession 调一次,resume = applicationSid (复用 caller 入参 sid 不创建新 row) +
    // resumeMode='fresh-cli-reuse-app' 显式触发 fresh CLI thread 但复用 applicationSid
    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0]).toMatchObject({
      cwd: '/tmp/abandoned',
      prompt: 'hi',
      resume: 'sess-no-jsonl',
      resumeMode: 'fresh-cli-reuse-app',
      permissionMode: 'acceptEdits', // 但 permissionMode 仍要复原
      // REVIEW_36 HIGH-1: claudeCodeSandbox 也透传（fixture 中 record 没设此字段，应为 undefined）
      claudeCodeSandbox: undefined,
    });

    // 占位 message 仍 emit（用户体感「在自动恢复」与正常 resume 路径一致）
    const placeholders = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('正在自动恢复'),
    );
    expect(placeholders).toHaveLength(1);

    // CHANGELOG_106 bug fix:jsonl missing 路径必须 emit info message 告诉用户
    // 「CLI 历史已丢失,Claude 不知前情,需重新告知背景」— 否则 SessionDetail 看完整历史
    // + Claude 答非所问 = 用户问「你是不是没有历史会话信息了」(实测用户报)。与 cwdFellBack
    // 路径(已 emit `启发式 fallback 到`)对称。
    const jsonlLostInfo = emits.filter((e) => {
      const p = e.payload as { text?: string; error?: boolean };
      return (p.text ?? '').includes('CLI 内部对话历史(jsonl)已丢失');
    });
    expect(jsonlLostInfo).toHaveLength(1);
    expect(jsonlLostInfo[0].sessionId).toBe('sess-no-jsonl');
    // info 性质,不打 error: true(与 cwdFellBack 路径一致;打 error 时间线像系统崩误导用户)
    expect((jsonlLostInfo[0].payload as { error?: boolean }).error).not.toBe(true);
    // 关键文案断言:「请...再告诉它一次」让用户知道下条消息要补充背景
    expect((jsonlLostInfo[0].payload as { text: string }).text).toMatch(/再告诉它一次|背景/);
  });

  // ─── CHANGELOG_99 cwd 失效启发式 fallback ────────────────────────────

  it('CHANGELOG_99: cwd 不存在 + .claude/worktrees/ 启发式命中 → fallback main repo + 走 jsonl missing 同款下游', async () => {
    const bridge = makeBridge();
    // Map mock:dead worktree path 不存在 + main repo 存在 → 启发式 1 命中
    bridge.cwdExistsOverride = new Map<string, boolean>([
      ['/Users/apple/myrepo/.claude/worktrees/dead-plan', false],
      ['/Users/apple/myrepo', true],
    ]);
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-cwd-bad',
      agentId: 'claude-code',
      cwd: '/Users/apple/myrepo/.claude/worktrees/dead-plan',
      title: 'x',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: 3,
      archivedAt: null,
      permissionMode: 'plan',
    });

    await bridge.sendMessage('sess-cwd-bad', 'hi');

    // createSession 被调一次,cwd = main repo (启发式 1 命中)
    // **plan reverse-rename-sid-stability-20260520 §A.4-pre S8 修订**: cwdFellBack=true 仍走
    // jsonl missing 同款下游(resumeMode='fresh-cli-reuse-app' + resume = applicationSid)
    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0]).toMatchObject({
      cwd: '/Users/apple/myrepo',
      prompt: 'hi',
      resume: 'sess-cwd-bad',
      resumeMode: 'fresh-cli-reuse-app',
      permissionMode: 'plan',
    });

    // **plan §A.4-pre S6+S8 修订**: 反向 rename 后 sessions.id 不变;jsonl missing fallback
    // 路径 cli sid 写入交给 createThunk 内部 sessionManager.updateCliSessionId 走黑名单链
    // (不再 renameSdkSession 切 sessions.id)。本测试用 mock createSession 没真跑 SDK 流,
    // 故 updateCliSessionId 不会被实际调用 — 只断言旧 renameSdkSession 不再因 fallback 被调。
    expect(sessionManager.renameSdkSession).not.toHaveBeenCalledWith('sess-cwd-bad', 'new-sid');

    // emit 一条 info message(不打 error)告诉用户 fallback 发生
    const fallbackInfo = emits.filter((e) => {
      const p = e.payload as { text?: string };
      return (p.text ?? '').includes('启发式 fallback 到');
    });
    expect(fallbackInfo).toHaveLength(1);
    expect((fallbackInfo[0]!.payload as { error?: boolean }).error).not.toBe(true);
    expect((fallbackInfo[0]!.payload as { text: string }).text).toContain('/Users/apple/myrepo');

    // placeholder 也 emit(用户体感"在自动恢复")
    const placeholders = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('正在自动恢复'),
    );
    expect(placeholders).toHaveLength(1);
  });

  it('CHANGELOG_99: cwd 不存在 + 启发式全 miss → emit error + throw,不进 placeholder 路径', async () => {
    const bridge = makeBridge();
    // Map 全 false → 启发式 1 (main repo 不存在) + 启发式 2 (parent walk 全部不存在) 全 miss
    bridge.cwdExistsOverride = new Map<string, boolean>(); // 空 Map = 任何路径都返 false
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-no-rescue',
      agentId: 'claude-code',
      cwd: '/some/random/dead/path',
      title: 'x',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: 3,
      archivedAt: null,
    });

    await expect(bridge.sendMessage('sess-no-rescue', 'hi')).rejects.toThrow(
      /cwd does not exist and no fallback available/,
    );

    // createSession 不被调(短路 throw 在前)
    expect(bridge.createCalls).toHaveLength(0);

    // emit error message 说明 cwd 不存在 + 启发式都失败
    const errorMessages = emits.filter((e) => {
      const p = e.payload as { text?: string; error?: boolean };
      return p.error === true && (p.text ?? '').includes('cwd 已不存在');
    });
    expect(errorMessages).toHaveLength(1);

    // **不**emit placeholder「正在自动恢复」(误导)
    const placeholders = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('正在自动恢复'),
    );
    expect(placeholders).toHaveLength(0);
  });

  it('CHANGELOG_99: cwd 不存在 + 启发式 1 不命中 + parent walk 命中 → fallback 到父目录', async () => {
    const bridge = makeBridge();
    // 路径不含 .claude/worktrees/ → 启发式 1 跳过;parent walk 找到第一个存在的目录
    bridge.cwdExistsOverride = new Map<string, boolean>([
      ['/Users/apple/some/deep/dead/cwd', false],
      ['/Users/apple/some/deep/dead', false], // parent 1
      ['/Users/apple/some/deep', false], // parent 2
      ['/Users/apple/some', true], // parent 3 命中 ✓
    ]);
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-walk',
      agentId: 'claude-code',
      cwd: '/Users/apple/some/deep/dead/cwd',
      title: 'x',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: 3,
      archivedAt: null,
    });

    await bridge.sendMessage('sess-walk', 'hi');

    // fallback 到 parent walk 第一个存在的目录
    // **plan §A.4-pre S8 修订**: cwdFellBack=true 走 jsonl missing 同款下游,resume = applicationSid + resumeMode
    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0]?.cwd).toBe('/Users/apple/some');
    expect(bridge.createCalls[0]?.resume).toBe('sess-walk');
    expect(bridge.createCalls[0]?.resumeMode).toBe('fresh-cli-reuse-app');
  });

  it('CHANGELOG_99: cwd 存在 → 不触发 fallback,走原 resume 主路径(回归保护)', async () => {
    const bridge = makeBridge();
    // cwdExistsOverride 默认 true,不需显式设
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-ok',
      agentId: 'claude-code',
      cwd: '/tmp/x',
      title: 'x',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: 3,
      archivedAt: null,
      permissionMode: 'acceptEdits',
    });

    await bridge.sendMessage('sess-ok', 'hi');

    // createSession 走原 resume 主路径
    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0]).toMatchObject({
      cwd: '/tmp/x',
      prompt: 'hi',
      resume: 'sess-ok', // resume 仍带
      permissionMode: 'acceptEdits',
    });

    // **不**emit cwd fallback info message
    const fallbackInfo = emits.filter((e) => {
      const p = e.payload as { text?: string };
      return (p.text ?? '').includes('启发式 fallback 到');
    });
    expect(fallbackInfo).toHaveLength(0);
  });

  // ─── CHANGELOG_107 LLM 摘要 fallback 自动注入 ────────────────────────────

  it('CHANGELOG_107: jsonl 不存在 + 摘要成功 → prepended prompt + emit「LLM 摘要已注入」', async () => {
    const bridge = makeBridge();
    bridge.jsonlExistsOverride = false;
    bridge.summariseOverride = '用户在做 X,已完成 Y,下一步 Z';
    // listEventsFn 返非空让 helper 不走 'no-events' fallback;具体内容不重要(thunk mock 返固定字符串)
    vi.mocked(eventRepo.listForSession).mockReturnValue([
      {
        id: 1,
        sessionId: 'sess-summary-ok',
        agentId: '',
        kind: 'message',
        payload: { text: 'hi' },
        ts: 1,
      },
    ]);
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-summary-ok',
      agentId: 'claude-code',
      cwd: '/tmp/with-summary',
      title: 'x',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      permissionMode: 'plan',
    });

    await bridge.sendMessage('sess-summary-ok', '继续之前的话题');

    // createSession 用 prepended prompt(含五等号块 + summary + originalText)
    expect(bridge.createCalls).toHaveLength(1);
    const createdPrompt = bridge.createCalls[0]?.prompt ?? '';
    expect(createdPrompt).toContain('===== 历史会话摘要');
    expect(createdPrompt).toContain('用户在做 X,已完成 Y,下一步 Z');
    expect(createdPrompt).toContain('===== 用户当前消息');
    expect(createdPrompt).toContain('继续之前的话题');
    expect(bridge.createCalls[0]?.resume).toBe('sess-summary-ok'); // **§A.4-pre S8 修订**: resume = applicationSid 复用

    // emit「LLM 摘要自动注入」info(不打 error)
    const summaryOk = emits.filter((e) => {
      const p = e.payload as { text?: string; error?: boolean };
      return (p.text ?? '').includes('应用通过 LLM 摘要自动注入');
    });
    expect(summaryOk).toHaveLength(1);
    expect((summaryOk[0]!.payload as { error?: boolean }).error).not.toBe(true);
    expect((summaryOk[0]!.payload as { text: string }).text).toContain('Claude 应能续上前情');

    // **不**emit CHANGELOG_106「请补背景」原文案(摘要成功 ≠ 丢失)
    const compatNotice = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('请在下条消息里把背景再告诉它一次'),
    );
    expect(compatNotice).toHaveLength(0);
  });

  it('CHANGELOG_107: jsonl 不存在 + settings.autoSummariseOnFallback=false → skip 摘要,走原 CHANGELOG_106 文案', async () => {
    const bridge = makeBridge();
    bridge.jsonlExistsOverride = false;
    bridge.summariseOverride = '不应被调用(settings off 在前)';
    // settings off — 即使 listEvents 非空也不该调 summariseFn
    vi.mocked(settingsStore.get).mockImplementation(((key: unknown) => {
      if (key === 'autoSummariseOnFallback') return false;
      return undefined;
    }) as never);
    vi.mocked(eventRepo.listForSession).mockReturnValue([
      {
        id: 1,
        sessionId: 'sess-settings-off',
        agentId: '',
        kind: 'message',
        payload: { text: 'hi' },
        ts: 1,
      },
    ]);
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-settings-off',
      agentId: 'claude-code',
      cwd: '/tmp/no-summary',
      title: 'x',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      permissionMode: null,
    });

    await bridge.sendMessage('sess-settings-off', 'hi');

    // createSession 用原 prompt(不 prepend 摘要)
    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0]?.prompt).toBe('hi');

    // emit 原 CHANGELOG_106 文案(走 fallback 失败分支)
    const compatNotice = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('请在下条消息里把背景再告诉它一次'),
    );
    expect(compatNotice).toHaveLength(1);

    // **不**emit「LLM 摘要自动注入」(根本没调 summariseFn)
    const summaryOk = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('应用通过 LLM 摘要自动注入'),
    );
    expect(summaryOk).toHaveLength(0);
  });

  it('CHANGELOG_107: jsonl 不存在 + summariseFn throw → skip 摘要,走原 CHANGELOG_106 文案', async () => {
    const bridge = makeBridge();
    bridge.jsonlExistsOverride = false;
    bridge.summariseThrow = new Error('LLM timeout: __handoff_summary_timeout__');
    vi.mocked(eventRepo.listForSession).mockReturnValue([
      {
        id: 1,
        sessionId: 'sess-thunk-throw',
        agentId: '',
        kind: 'message',
        payload: { text: 'hi' },
        ts: 1,
      },
    ]);
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-thunk-throw',
      agentId: 'claude-code',
      cwd: '/tmp/llm-fail',
      title: 'x',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      permissionMode: null,
    });

    // helper 内 try/catch 把 thunk throw 封装到 PrependResult.thrown,recoverer
    // 主路径不抛错 → sendMessage 正常完成 + createSession 用原 prompt
    await bridge.sendMessage('sess-thunk-throw', 'hi');

    // createSession 用原 prompt(thunk throw 退到 originalText)
    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0]?.prompt).toBe('hi');

    // emit 原 CHANGELOG_106 文案
    const compatNotice = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('请在下条消息里把背景再告诉它一次'),
    );
    expect(compatNotice).toHaveLength(1);

    // **不**emit「LLM 摘要自动注入」(thunk throw 退回原 prompt 不算注入成功)
    const summaryOk = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('应用通过 LLM 摘要自动注入'),
    );
    expect(summaryOk).toHaveLength(0);
  });

  it('CHANGELOG_107: cwdFellBack=true + 摘要成功 → prepended prompt + emit cwdFellBack 摘要成功文案', async () => {
    const bridge = makeBridge();
    // 启发式 1 命中(worktrees 路径取段之前)
    bridge.cwdExistsOverride = new Map<string, boolean>([
      ['/Users/apple/myrepo/.claude/worktrees/dead-plan', false],
      ['/Users/apple/myrepo', true],
    ]);
    bridge.summariseOverride = 'cwdFellBack 摘要内容';
    vi.mocked(eventRepo.listForSession).mockReturnValue([
      {
        id: 1,
        sessionId: 'sess-cwd-summary',
        agentId: '',
        kind: 'message',
        payload: { text: 'hi' },
        ts: 1,
      },
    ]);
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-cwd-summary',
      agentId: 'claude-code',
      cwd: '/Users/apple/myrepo/.claude/worktrees/dead-plan',
      title: 'x',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: 3,
      archivedAt: null,
      permissionMode: 'plan',
    });

    await bridge.sendMessage('sess-cwd-summary', 'hi');

    // createSession cwd = main repo (启发式 1) + prompt 含 prepended 摘要
    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0]?.cwd).toBe('/Users/apple/myrepo');
    expect(bridge.createCalls[0]?.resume).toBe('sess-cwd-summary'); // **§A.4-pre S8 修订**: resume = applicationSid 复用
    const createdPrompt = bridge.createCalls[0]?.prompt ?? '';
    expect(createdPrompt).toContain('===== 历史会话摘要');
    expect(createdPrompt).toContain('cwdFellBack 摘要内容');
    expect(createdPrompt).toContain('===== 用户当前消息');

    // emit cwdFellBack 摘要成功文案(含「在新 cwd 续上」字眼区分 jsonl missing 路径)
    const summaryOk = emits.filter((e) => {
      const p = e.payload as { text?: string };
      return (
        (p.text ?? '').includes('应用通过 LLM 摘要自动注入') &&
        (p.text ?? '').includes('在新 cwd 续上')
      );
    });
    expect(summaryOk).toHaveLength(1);

    // outer cwdFellBack info 仍 emit「启发式 fallback 到」(Step 4 简化保留 cwd 切换 fact)
    const fallbackInfo = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('启发式 fallback 到'),
    );
    expect(fallbackInfo).toHaveLength(1);

    // **不**emit cwdFellBack「将丢失」原文案(摘要成功 ≠ 丢失)
    const willLoseNotice = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('CLI 内部对话历史(jsonl)将丢失'),
    );
    expect(willLoseNotice).toHaveLength(0);
  });

  // ─── REVIEW_36 HIGH-1: recoverer fallback claudeCodeSandbox 透传回归 ────────
  //
  // 修前漏洞：fallback 路径调 createThunk 没传 claudeCodeSandbox，sandbox-resolve 拿
  // opts.resume=undef + opts.claudeCodeSandbox=undef → 走 settings 全局 fallback（默认 'off'）
  // → SDK 子进程实际无沙盒，与 sessionRepo.claudeCodeSandbox='strict' 完全脱钩。
  //
  // 这两个 case 锁定 fix：fallback 路径必须把 rec.claudeCodeSandbox 显式透传给 createThunk。

  it('REVIEW_36 HIGH-1: jsonl 不存在 + record claudeCodeSandbox=strict → fallback 透传 strict', async () => {
    const bridge = makeBridge();
    bridge.jsonlExistsOverride = false;
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-strict',
      agentId: 'claude-code',
      cwd: '/tmp/sandboxed',
      title: 'strict-session',
      source: 'sdk',
      lifecycle: 'closed',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: 3,
      archivedAt: null,
      permissionMode: 'default',
      // 关键：用户上次主动选了 strict
      claudeCodeSandbox: 'strict',
    });

    await bridge.sendMessage('sess-strict', 'hi');

    expect(bridge.createCalls).toHaveLength(1);
    // 关键断言：fallback 路径必须把 record.claudeCodeSandbox 透传给 createThunk
    // （而不是 undefined → sandbox-resolve fallback 到 settings 全局 'off' 静默降级）
    expect(bridge.createCalls[0].claudeCodeSandbox).toBe('strict');
  });

  it('REVIEW_36 HIGH-1: 正常 resume + record claudeCodeSandbox=workspace-write → 透传', async () => {
    const bridge = makeBridge();
    // jsonl 默认 true → 走正常 resume 路径
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-ws',
      agentId: 'claude-code',
      cwd: '/tmp/work',
      title: 'ws-session',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      permissionMode: null,
      claudeCodeSandbox: 'workspace-write',
    });

    await bridge.sendMessage('sess-ws', 'hi');

    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0].resume).toBe('sess-ws');
    expect(bridge.createCalls[0].claudeCodeSandbox).toBe('workspace-write');
  });

  // ─── plan cross-adapter-parity-20260515 Phase A.9: extraAllowWrite 持久化往返 ──────
  //
  // 修前漏洞:hand_off_session 外置 worktree caller 传 [mainRepo] 让 session 能写 mainRepo
  // plan 文件,但 sessions.extra_allow_write 列不存在 → app 重启 / sdk-bridge state lost /
  // recoverer fallback 路径 createThunk 不带 extraAllowWrite → SDK sandbox.allowWrite 不含
  // 原 mainRepo → 写 plan 文件静默失败(sandbox 拦)→ 用户体感 plan 完成时 frontmatter
  // 更新失败莫名其妙(REVIEW_40 R1 reviewer-codex MED-F)。
  //
  // 这两个 case 锁定 fix:fallback 路径 + 正常 resume 路径都必须把 rec.extraAllowWrite 显式
  // 透传给 createThunk(与 claudeCodeSandbox / model HIGH-1 同款治法)。

  it('parity-plan A.9: jsonl 不存在 + record extraAllowWrite=[mainRepo] → fallback 透传', async () => {
    const bridge = makeBridge();
    bridge.jsonlExistsOverride = false;
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-extra-fb',
      agentId: 'claude-code',
      cwd: '/tmp/worktree',
      title: 'extra-allow-fallback',
      source: 'sdk',
      lifecycle: 'closed',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: 3,
      archivedAt: null,
      permissionMode: null,
      claudeCodeSandbox: 'workspace-write',
      // 关键:hand_off_session 外置 worktree caller 传 [mainRepo] 持久化到 record
      extraAllowWrite: ['/Users/apple/mainrepo'],
    });

    await bridge.sendMessage('sess-extra-fb', 'hi');

    expect(bridge.createCalls).toHaveLength(1);
    // 关键断言:fallback 路径必须把 record.extraAllowWrite 透传给 createThunk
    // (而不是 undefined → SDK sandbox.allowWrite 不含 mainRepo,写 plan 文件静默失败)
    expect(bridge.createCalls[0].extraAllowWrite).toEqual(['/Users/apple/mainrepo']);
    // claudeCodeSandbox 也透传(回归 REVIEW_36 HIGH-1)
    expect(bridge.createCalls[0].claudeCodeSandbox).toBe('workspace-write');
  });

  it('parity-plan A.9: 正常 resume + record extraAllowWrite=[mainRepo] → 透传', async () => {
    const bridge = makeBridge();
    // jsonl 默认 true → 走正常 resume 路径
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-extra-resume',
      agentId: 'claude-code',
      cwd: '/tmp/worktree',
      title: 'extra-allow-resume',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      permissionMode: null,
      claudeCodeSandbox: 'workspace-write',
      extraAllowWrite: ['/Users/apple/mainrepo', '/Users/apple/anotherrepo'],
    });

    await bridge.sendMessage('sess-extra-resume', 'hi');

    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0].resume).toBe('sess-extra-resume');
    // 关键断言:resume 路径同款显式透传(防 sessionRepo 边界 race + 与 claudeCodeSandbox 对称)
    expect(bridge.createCalls[0].extraAllowWrite).toEqual([
      '/Users/apple/mainrepo',
      '/Users/apple/anotherrepo',
    ]);
  });

  it('parity-plan A.9: record extraAllowWrite=null → 透传 undefined(历史 NULL 兜底)', async () => {
    const bridge = makeBridge();
    // jsonl 默认 true → 走正常 resume 路径
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-null-extra',
      agentId: 'claude-code',
      cwd: '/tmp/worktree',
      title: 'null-extra',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      permissionMode: null,
      // 关键:历史 record(本 plan land 之前创建的 session)extraAllowWrite=null
      extraAllowWrite: null,
    });

    await bridge.sendMessage('sess-null-extra', 'hi');

    expect(bridge.createCalls).toHaveLength(1);
    // 关键断言:rec.extraAllowWrite=null → ?? undefined → createThunk 收 undefined
    // (与 caller 不传 extraAllowWrite 行为同款,sandbox.allowWrite 仅含 cwd + /tmp + cache,
    // 历史 NULL 不强升级行为保兼容)
    expect(bridge.createCalls[0].extraAllowWrite).toBeUndefined();
  });

  // ─── plan cross-adapter-parity-20260515 Phase B.4: waiter Promise<string> regression ──
  //
  // 修前漏洞:recoverer.recoverAndSend 返 Promise<void> → 等待者 path `try{await inflight}catch{}
  // return this.sendThunk(sessionId, text, atts)` 用 OLD sessionId 调 sendThunk → 走
  // bridge.sendMessage(OLD) → sessions.get(OLD) miss(主 recovery fallback rename 已 OLD→NEW)
  // → 又进 recoverAndSend(OLD) → sessionRepo.get(OLD) === null(rename DELETE OLD row) → throw
  // "not found" — 用户体感「第二条消息消失」(REVIEW_40 R2 reviewer-codex MED parity 限制)。
  //
  // 修后 recoverAndSend 返 Promise<string>(返 finalId / fallback path 返 newRealId / resume
  // path 返 sessionId)。等待者 path `let finalId; try{finalId=await inflight as string}
  // catch{finalId=sessionId} return this.sendThunk(finalId, text, atts)` 用 NEW sid 调
  // sendThunk → bridge.sendMessage(NEW) → sessions.get(NEW) 命中(主 recovery 完成后已 sync)
  // → 直接 push 进 NEW session pendingMessages,不再 recursive recovery 撞 not found。

  it('parity-plan B.4: 2 并发 sendMessage + jsonl missing fallback (反向 rename 后 applicationSid 不变) → 第二条 waiter 拿 applicationSid 不撞 not found', async () => {
    const bridge = makeBridge();
    bridge.createBehavior = 'block'; // 让第一波 createSession 阻塞,模拟 recovery in-flight 期间第二条 arrival
    bridge.jsonlExistsOverride = false; // 走 jsonl missing fallback 路径
    // **plan reverse-rename-sid-stability-20260520 §A.4-pre S5+S8 修订**:
    // 反向 rename 后 createSession 返 applicationSid (= 'sess-waiter') 不再是 'new-sid';
    // intercept 'sess-waiter' 模拟 sessions Map 在 recovery 后已 sync 命中(本测试用 mock createSession
    // 没真跑 SDK 流,sessions Map 不会被自动 set,intercept seam 模拟该状态)。
    // skip first 2 calls 因为反向 rename 后 p1/p2 都用 'sess-waiter' 进 recoverer (与原 'new-sid'
    // 仅 waiter 调用区分不同) — 计数让前 2 次走 super (p1 + p2 进 recoverer),第 3 次 (waiter
    // post-recoverer sendThunk → bridge.sendMessage) 才真 intercept。
    bridge.interceptSidSet = new Set(['sess-waiter']);
    bridge.interceptSkipFirstCalls = 2;
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-waiter',
      agentId: 'claude-code',
      cwd: '/tmp/waiter',
      title: 'waiter',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      permissionMode: null,
    });

    // 第一波 sendMessage(不 await,让 inflight Promise 注册到 recovering Map)
    const p1 = bridge.sendMessage('sess-waiter', 'first').catch(() => undefined);
    // microtask flush,确保 p1 已经把 inflight 写入 recovering Map
    await Promise.resolve();
    await Promise.resolve();
    // 第二波同 sessionId(进 inflight 等待者 path)
    const p2 = bridge.sendMessage('sess-waiter', 'second').catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    // createSession 此刻只被调过一次(单飞,第二条等同一 inflight)
    expect(bridge.createCalls).toHaveLength(1);

    // 解锁 inflight,让两波 promise 都退出
    bridge.unblock?.();
    await p1;
    await p2;

    // **§A.4-pre S5 修订**: waiter path 调 sendThunk 用 finalId='sess-waiter' (applicationSid 不变);
    // 反向 rename 前: createSession 返 'new-sid' → waiter 拿 'new-sid';
    // 反向 rename 后: createSession 返 applicationSid 'sess-waiter' → waiter 拿 'sess-waiter' (稳定不变)。
    expect(bridge.sendMessageCalls).toHaveLength(1);
    expect(bridge.sendMessageCalls[0].sessionId).toBe('sess-waiter');
    // 关键断言 #2:waiter 带的是自己的 text 'second' 不是 'first'(独立 message)
    expect(bridge.sendMessageCalls[0].text).toBe('second');

    // 没 emit error message(修前会 emit「⚠ 自动恢复失败」之类 error)
    const errorMsgs = emits.filter((e) => {
      const p = e.payload as { error?: boolean; text?: string };
      return p.error === true && (p.text ?? '').includes('自动恢复失败');
    });
    expect(errorMsgs).toHaveLength(0);
  });

  it('REVIEW_41 MED-2 fix: 2 并发 sendMessage + resume implicit fork → 第二条 waiter 拿 forked-id 不撞 not found', async () => {
    const bridge = makeBridge();
    bridge.createBehavior = 'block';
    // 关键:走 resume 主路径(jsonl 在),不走 fallback;用 forkOnResumeOverride 模拟 CLI 隐式 fork
    bridge.forkOnResumeOverride = 'forked-id'; // resume 路径 createSession 返 'forked-id' 而非 OLD
    bridge.interceptSidSet = new Set(['forked-id']); // 仅 'forked-id' intercept(模拟 sessions Map sync 完后命中)
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-fork',
      agentId: 'claude-code',
      cwd: '/tmp/fork',
      title: 'fork-resume',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      permissionMode: null,
    });

    const p1 = bridge.sendMessage('sess-fork', 'first').catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    const p2 = bridge.sendMessage('sess-fork', 'second').catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0].resume).toBe('sess-fork'); // 验证走 resume 路径(不是 fallback)

    bridge.unblock?.();
    await p1;
    await p2;

    // 关键断言:waiter path 拿 finalId='forked-id'(handle.sessionId)而非 OLD 'sess-fork'
    // 修前 recoverer resume path 固定 `return sessionId` → 等待者拿 OLD sessionId 撞 not found
    // (REVIEW_41 reviewer-codex MED-2 单方提出 + lead grep 实证修法 partial fix only fallback)
    expect(bridge.sendMessageCalls).toHaveLength(1);
    expect(bridge.sendMessageCalls[0].sessionId).toBe('forked-id');
    expect(bridge.sendMessageCalls[0].text).toBe('second');
  });
});
