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

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: {
    get: vi.fn(),
  },
}));

vi.mock('@main/store/event-repo', () => ({
  eventRepo: {
    listForSession: vi.fn(() => []),
  },
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: {
    get: vi.fn((key: string) => {
      if (key === 'autoSummariseOnFallback') return true;
      return undefined;
    }),
  },
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

vi.mock('@main/adapters/claude-code/sdk-loader', () => ({
  loadSdk: vi.fn(),
}));

vi.mock('@main/adapters/claude-code/sdk-runtime', () => ({
  getSdkRuntimeOptions: () => ({ executable: 'node', env: {} }),
  getPathToClaudeCodeExecutable: () => '/fake/cli',
}));

vi.mock('@main/adapters/claude-code/sdk-injection', () => ({
  getAgentDeckPluginPath: () => '/fake/plugin',
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

    // createSession 被调一次，**不带 resume** —— 走新建 CLI session 路径
    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0]).toEqual({
      cwd: '/tmp/abandoned',
      prompt: 'hi',
      resume: undefined, // 关键：fallback 路径不带 resume
      permissionMode: 'acceptEdits', // 但 permissionMode 仍要复原
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

    // createSession 被调一次,cwd = main repo (启发式 1 命中),不带 resume(强制走 jsonl missing 下游)
    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0]).toEqual({
      cwd: '/Users/apple/myrepo',
      prompt: 'hi',
      resume: undefined, // cwdFellBack=true 强制不 resume
      permissionMode: 'plan',
    });

    // CHANGELOG_99 R1 fix LOW-8:验证 cwdFellBack 下游路径调 renameSdkSession 把 OLD_ID
    // 子表迁到 NEW_ID(应用层 events / file_changes / summaries 历史保留)。这条是
    // cwdFellBack=true 下游正确性的核心回归点(CHANGELOG_99 Phase C 主要承诺之一)。
    // mockSpawn returns sessionId='new-sid' (TestBridge default),OLD_ID='sess-cwd-bad' →
    // newRealId !== sessionId,触发 renameSdkSession 调用。
    expect(sessionManager.renameSdkSession).toHaveBeenCalledWith('sess-cwd-bad', 'new-sid');

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
    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0]?.cwd).toBe('/Users/apple/some');
    expect(bridge.createCalls[0]?.resume).toBeUndefined(); // cwdFellBack 强制不 resume
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
    expect(bridge.createCalls[0]?.resume).toBeUndefined(); // jsonl missing 路径仍不带 resume

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
    expect(bridge.createCalls[0]?.resume).toBeUndefined();
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
});
