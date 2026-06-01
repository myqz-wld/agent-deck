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
import type { UploadedAttachmentRef } from '@shared/types';
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
    // plan resume-inject-raw-messages-20260601 §D5: message-only 查询 + maxEventId（injectResumeHistory
    // 双数据源 + beforeIdInclusive 来源）。默认空 / null 让现有 case 走 no-history（used=false）；
    // 「raw 成功」case 显式 mockReturnValue 一条 message。
    listRecentMessages: vi.fn(() => []),
    maxEventId: vi.fn(() => null),
  },
}));

vi.mock('@main/store/settings-store', () => ({
  settingsStore: makeSettingsStoreMock({
    overrides: {
      get: vi.fn((key: string) => {
        // plan resume-inject-raw-messages-20260601 §D5: autoSummariseOnFallback 已删（无条件注入），
        // 改 resumeRecentMessagesCount（injectResumeHistory 拉最近 N 条原始对话）。
        if (key === 'resumeRecentMessagesCount') return 30;
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
    // REVIEW_76 MED: recoverAndSend 失败路径 closed→active 复活回滚走 sessionManager.markClosed
    markClosed: vi.fn(),
    // REVIEW_99 R3 cancellation-epoch: recover 入口捕 baseline + 多检查点比对。默认返 0 恒定
    // (= 不 close → 合法 resume 不误 abort);close-during-await 测试用 mockReturnValueOnce 序列
    // 模拟「baseline 捕获返 0 → await 后返 1」(epoch 变 → cancelGuard true → abort)。
    getCloseEpoch: vi.fn(() => 0),
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
  // REVIEW_99 R3 cancellation-epoch: reset getCloseEpoch 默认返 0(不 close → 合法 resume 不误 abort)
  vi.mocked(sessionManager.getCloseEpoch).mockReset();
  vi.mocked(sessionManager.getCloseEpoch).mockReturnValue(0);
  vi.mocked(sessionManager.markClosed).mockReset();
  // CHANGELOG_107 Step 6 配套:reset event-repo / settings-store mock 让 case 间隔离
  vi.mocked(eventRepo.listForSession).mockReset();
  vi.mocked(eventRepo.listForSession).mockReturnValue([]);
  // plan resume-inject-raw-messages-20260601 §D5: reset 新增 message-only 查询 + maxEventId mock
  vi.mocked(eventRepo.listRecentMessages).mockReset();
  vi.mocked(eventRepo.listRecentMessages).mockReturnValue([]);
  vi.mocked(eventRepo.maxEventId).mockReset();
  vi.mocked(eventRepo.maxEventId).mockReturnValue(null);
  vi.mocked(settingsStore.get).mockReset();
  vi.mocked(settingsStore.get).mockImplementation(((key: unknown) => {
    if (key === 'resumeRecentMessagesCount') return 30;
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
    expect(bridge.createCalls[0]).toMatchObject({
      cwd: '/tmp/work',
      prompt: 'hi',
      resume: 'sess-1',
      permissionMode: 'plan',
      // REVIEW_36 HIGH-1: 正常 resume 路径也透传（fixture 中 record 没设字段，undefined）
      claudeCodeSandbox: undefined,
    });
    // REVIEW_99 R3 cancellation-epoch: normal-resume 路径透传 cancelCheck thunk(MED post-guard 窗口)
    expect(typeof bridge.createCalls[0].cancelCheck).toBe('function');
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
    // plan resume-inject §D5: raw 段是底线，used=true 需 listRecentMessages 返非空原始对话
    vi.mocked(eventRepo.listRecentMessages).mockReturnValue([
      {
        id: 1,
        sessionId: 'sess-summary-ok',
        agentId: '',
        kind: 'message',
        payload: { role: 'user', text: '历史问题' },
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

  it('plan resume-inject §不变量7: 无条件注入（无 settings off 开关）+ DB 无历史 → 退回原 prompt 走 skipped 文案', async () => {
    const bridge = makeBridge();
    bridge.jsonlExistsOverride = false;
    bridge.summariseOverride = '不应被注入(DB 无原始对话消息 → no-history)';
    // plan resume-inject §不变量7: autoSummariseOnFallback 开关已删（无条件注入）。
    // DB 无原始对话消息（listRecentMessages 空）→ injectResumeHistory no-history → used=false →
    // 退回原 prompt（raw 段是底线，仅总结无 raw 不注入）。
    vi.mocked(eventRepo.listForSession).mockReturnValue([
      {
        id: 1,
        sessionId: 'sess-no-history',
        agentId: '',
        kind: 'message',
        payload: { text: 'hi' },
        ts: 1,
      },
    ]);
    // listRecentMessages 默认空（beforeEach）→ no-history
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-no-history',
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

    await bridge.sendMessage('sess-no-history', 'hi');

    // createSession 用原 prompt(no-history 退回 originalText，不 prepend)
    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0]?.prompt).toBe('hi');

    // emit skipped 文案(走 used=false 分支)
    const compatNotice = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('请在下条消息里把背景再告诉它一次'),
    );
    expect(compatNotice).toHaveLength(1);

    // **不**emit「LLM 摘要自动注入」(no-history 退回前不拼总结)
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
    // plan resume-inject §D5: raw 段是底线，used=true 需 listRecentMessages 返非空原始对话
    vi.mocked(eventRepo.listRecentMessages).mockReturnValue([
      {
        id: 1,
        sessionId: 'sess-cwd-summary',
        agentId: '',
        kind: 'message',
        payload: { role: 'user', text: '历史问题' },
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

  // ─── REVIEW_58 HIGH ✅ regression: recoverAndSend 入口 emit user message 收口 ──────────
  // bug 截图证据: 用户发消息 → 看「⚠ SDK 通道已断开,正在自动恢复…」+ 后续 assistant「✅ 一轮完成」
  // 但**自己发的那条 user message 不显示**(emit 责任全下放 createSession 内 finalize / fallback
  // 跨 SDK 实际 spawn 时序)。修法:recoverAndSend 入口与 live 主路径 sendMessage `if(s)` 路径
  // emit 时机对称 + 下游 createThunk 显式 skipFirstUserEmit:true 让 finalize 跳过避免双气泡。

  it('REVIEW_58 HIGH ✅: recoverAndSend 入口立即 emit user message (normal resume 路径仅 1 条 + user before placeholder)', async () => {
    const bridge = makeBridge();
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-user-msg',
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
      permissionMode: null,
    });

    await bridge.sendMessage('sess-user-msg', 'hello world');

    // role='user' message 恰好 1 条 (recoverAndSend 入口收口 + TestBridge mock createSession
    // 不调真 finalize,实战中 finalize 走 skipFirstUserEmit 守门跳过避免双气泡)
    const userMsgs = emits.filter(
      (e) => e.kind === 'message' && (e.payload as { role?: string }).role === 'user',
    );
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].sessionId).toBe('sess-user-msg');
    expect((userMsgs[0].payload as { text: string }).text).toBe('hello world');

    // 顺序: user message 在 placeholder「⚠ SDK 通道已断开」之前 emit
    // (用户体感: 先看到自己发的内容,再看占位)
    const userMsgIdx = emits.indexOf(userMsgs[0]);
    const placeholderIdx = emits.findIndex(
      (e) =>
        e.kind === 'message' &&
        ((e.payload as { text?: string }).text ?? '').includes('正在自动恢复'),
    );
    expect(placeholderIdx).toBeGreaterThan(-1);
    expect(userMsgIdx).toBeLessThan(placeholderIdx);
  });

  it('REVIEW_58 HIGH ✅: jsonl 不存在 fallback 路径同样仅 emit 1 条 user message (caller + helper 不双气泡)', async () => {
    const bridge = makeBridge();
    bridge.jsonlExistsOverride = false; // jsonl 缺失 → maybeJsonlFallback
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-fallback-user',
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
      permissionMode: null,
    });

    await bridge.sendMessage('sess-fallback-user', 'hi');

    // role='user' message 仅 1 条: recoverAndSend 入口 emit + maybeJsonlFallback 守门跳过
    const userMsgs = emits.filter(
      (e) => e.kind === 'message' && (e.payload as { role?: string }).role === 'user',
    );
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].sessionId).toBe('sess-fallback-user');
    expect((userMsgs[0].payload as { text: string }).text).toBe('hi');
  });

  it('REVIEW_58 HIGH ✅: createSession 失败 → user message 仍保留 events (失败路径不丢用户输入)', async () => {
    const bridge = makeBridge();
    bridge.createBehavior = 'reject';
    bridge.rejectWith = new Error('CLI auth expired');
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-fail-user',
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

    await expect(bridge.sendMessage('sess-fail-user', 'failed prompt')).rejects.toThrow(/CLI auth expired/);

    // createSession throw 之前 user message 已 emit (入口收口) → events 表保留用户输入
    const userMsgs = emits.filter(
      (e) => e.kind === 'message' && (e.payload as { role?: string }).role === 'user',
    );
    expect(userMsgs).toHaveLength(1);
    expect((userMsgs[0].payload as { text: string }).text).toBe('failed prompt');
  });

  it('REVIEW_58 HIGH ✅: attachments 透传 — recoverAndSend 入口 emit user message 含 attachments 字段', async () => {
    const bridge = makeBridge();
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-img',
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
      permissionMode: null,
    });

    const attachments: UploadedAttachmentRef[] = [
      { kind: 'uploaded', path: '/tmp/img.png', mime: 'image/png', bytes: 100 },
    ];

    await bridge.sendMessage('sess-img', 'with image', attachments);

    const userMsgs = emits.filter(
      (e) => e.kind === 'message' && (e.payload as { role?: string }).role === 'user',
    );
    expect(userMsgs).toHaveLength(1);
    expect((userMsgs[0].payload as { attachments?: UploadedAttachmentRef[] }).attachments).toEqual(
      attachments,
    );
  });

  it('REVIEW_58 R2 MED-1 ✅: cwd 全 miss throw 路径下 user message 仍 emit 入 events (双方 R2 共识真问题修法)', async () => {
    // bug:R1 修法把 emit user message 放在 cwd precheck 之后,cwd 全 miss `emit error + throw`
    // 路径下 user emit 永不执行 — 用户体感:看到 cwd missing error 红字 + 自己的 message bubble
    // 消失(与 R1 治的截图 bug 同款症状)。R2 MED-1 修法把 emit 提前到 cwd precheck 之前覆盖此 case。
    const bridge = makeBridge();
    // cwd 全部不存在 (启发式 1 worktrees regex 不命中 + 启发式 2 parent walk 也全 miss)
    bridge.cwdExistsOverride = false;
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-cwd-throw',
      agentId: 'claude-code',
      cwd: '/totally/dead/path',
      title: 'dead',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      permissionMode: null,
    });

    await expect(bridge.sendMessage('sess-cwd-throw', 'lost prompt')).rejects.toThrow(
      /cwd does not exist/,
    );

    // R2 MED-1 关键断言:cwd 全 miss throw 之前 user message 已 emit 进 events 表 (不丢用户输入)
    const userMsgs = emits.filter(
      (e) => e.kind === 'message' && (e.payload as { role?: string }).role === 'user',
    );
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].sessionId).toBe('sess-cwd-throw');
    expect((userMsgs[0].payload as { text: string }).text).toBe('lost prompt');

    // 顺序: user message 在 cwd missing error message 之前 (用户体感:先看到自己发的,再看错误说明)
    const userMsgIdx = emits.indexOf(userMsgs[0]);
    const cwdErrorIdx = emits.findIndex(
      (e) =>
        e.kind === 'message' &&
        ((e.payload as { text?: string }).text ?? '').includes('cwd 已不存在'),
    );
    expect(cwdErrorIdx).toBeGreaterThan(-1);
    expect(userMsgIdx).toBeLessThan(cwdErrorIdx);
  });
});

describe('REVIEW_76 MED: closed 会话恢复失败回滚 lifecycle（dead-active 幽灵防护）', () => {
  it('closed + cwd 全 miss throw → markClosed 回滚（不留 dead-active 幽灵）', async () => {
    const bridge = makeBridge();
    bridge.cwdExistsOverride = new Map<string, boolean>(); // 空 Map = 任何路径 false → 全 miss
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-closed-cwdmiss',
      agentId: 'claude-code',
      cwd: '/some/dead/path',
      title: 'x',
      source: 'sdk',
      lifecycle: 'closed', // ← 关键：closed 会话（user emit 会经 ingest→ensure 复活成 active）
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: 3,
      archivedAt: null,
    });

    await expect(bridge.sendMessage('sess-closed-cwdmiss', 'hi')).rejects.toThrow(
      /cwd does not exist and no fallback available/,
    );

    // **MED-1 核心断言**：closed 会话恢复失败 → markClosed 回滚（防 dead-active 幽灵）
    expect(vi.mocked(sessionManager.markClosed)).toHaveBeenCalledWith('sess-closed-cwdmiss');
    // createSession 不被调（cwd 全 miss 短路 throw 在 createSession 之前）
    expect(bridge.createCalls).toHaveLength(0);
  });

  it('closed + createSession reject → outer catch markClosed 回滚', async () => {
    const bridge = makeBridge();
    bridge.jsonlExistsOverride = false; // jsonl 缺失 → maybeJsonlFallback 走 createThunk
    bridge.createBehavior = 'reject';
    bridge.rejectWith = new Error('SDK spawn failed (simulated)');
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-closed-reject',
      agentId: 'claude-code',
      cwd: '/tmp/work', // cwd 存在（cwdExistsOverride 默认 true）→ 不走 cwd-miss 路径
      title: 'x',
      source: 'sdk',
      lifecycle: 'closed', // ← closed 会话
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: 3,
      archivedAt: null,
    });

    await expect(bridge.sendMessage('sess-closed-reject', 'hi')).rejects.toThrow(
      /SDK spawn failed/,
    );

    // **MED-1 核心断言**：createSession reject 后 outer catch markClosed 回滚
    expect(vi.mocked(sessionManager.markClosed)).toHaveBeenCalledWith('sess-closed-reject');
    // 自动恢复失败 error message 仍 emit（用户看到原因）
    const recoverFailMsgs = emits.filter(
      (e) => ((e.payload as { text?: string }).text ?? '').includes('自动恢复失败'),
    );
    expect(recoverFailMsgs).toHaveLength(1);
  });

  it('dormant + 恢复失败 → 不调 markClosed（dormant 复活成 active 是 desired，不回滚）', async () => {
    const bridge = makeBridge();
    bridge.cwdExistsOverride = new Map<string, boolean>(); // 全 miss
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-dormant-cwdmiss',
      agentId: 'claude-code',
      cwd: '/some/dead/path',
      title: 'x',
      source: 'sdk',
      lifecycle: 'dormant', // ← dormant（ensure 不复活 dormant，无需回滚）
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: 3,
      archivedAt: null,
    });

    await expect(bridge.sendMessage('sess-dormant-cwdmiss', 'hi')).rejects.toThrow(
      /cwd does not exist and no fallback available/,
    );

    // **MED-1 边界断言**：dormant 不调 markClosed（wasClosed=false，仅 closed 才回滚）
    expect(vi.mocked(sessionManager.markClosed)).not.toHaveBeenCalled();
  });

  it('closed + 恢复成功 → 不调 markClosed（成功复活成 active 是 desired）', async () => {
    const bridge = makeBridge();
    bridge.jsonlExistsOverride = true; // jsonl 在 → 正常 resume 路径
    bridge.createBehavior = 'resolve'; // createSession 成功
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-closed-ok',
      agentId: 'claude-code',
      cwd: '/tmp/work', // cwd 存在
      title: 'x',
      source: 'sdk',
      lifecycle: 'closed',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: 3,
      archivedAt: null,
    });

    await bridge.sendMessage('sess-closed-ok', 'hi');

    // **MED-1 边界断言**：恢复成功路径不回滚（closed 会话成功 resume 应保持 active）
    expect(vi.mocked(sessionManager.markClosed)).not.toHaveBeenCalled();
    expect(bridge.createCalls).toHaveLength(1);
  });
});

// ─── REVIEW_99 R3 cancellation-epoch: 恢复期间用户再次 close / post-guard 窗口 / waiter abort ───
//
// R3 carry-forward 修法替代 R2 `closed && !wasClosed` lifecycle 快照（漏「恢复期间第二次 close」+
// 撞集成测试 mock 不 revive gap）。epoch 是「close 动作发生过没有」的直接信号:recover 入口 emit
// user message 后捕 baseline,多检查点比对 getCloseEpoch !== baseline。
//
// mock 驱动方式:getCloseEpoch 默认返 0(beforeEach)。模拟「恢复期间 close」用 mockReturnValueOnce
// 序列 — 第 1 次调(入口捕 baseline)返 0,后续调(helper await 后 / createSession pre-registration)
// 返 1(epoch 变 → cancelGuard true → abort)。
describe('REVIEW_99 R3 cancellation-epoch: 恢复期间再次 close abort', () => {
  const closedRec = (id: string, cwd = '/tmp/work') => ({
    id,
    agentId: 'claude-code',
    cwd,
    title: 'x',
    source: 'sdk' as const,
    lifecycle: 'closed' as const,
    activity: 'idle' as const,
    startedAt: 1,
    lastEventAt: 2,
    endedAt: 3,
    archivedAt: null,
    permissionMode: null,
  });

  it('① 入口就 closed 合法 resume（epoch 恒 0 不变）→ 正常 createSession，不 abort', async () => {
    const bridge = makeBridge();
    // jsonl 在 → 正常 resume 路径;getCloseEpoch 恒 0(beforeEach 默认)= 无「恢复期间 close」
    vi.mocked(sessionRepo.get).mockReturnValue(closedRec('sess-legal-resume'));

    await bridge.sendMessage('sess-legal-resume', 'hi');

    // 合法 resume：epoch 不变 → cancelGuard 恒 false → 正常 createSession（不误 abort）
    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0].resume).toBe('sess-legal-resume');
    // 不 markClosed（恢复成功，closed→active 是 desired）
    expect(vi.mocked(sessionManager.markClosed)).not.toHaveBeenCalled();
  });

  it('② jsonl-fallback await 期间用户再次 close（epoch 变）→ aborted 不起 fresh CLI', async () => {
    const bridge = makeBridge();
    bridge.jsonlExistsOverride = false; // 走 jsonl-missing fallback（含 injectResumeHistory await）
    // getCloseEpoch: 第 1 次(入口 baseline) 0 → 第 2 次起(helper isCancelledFn await 后) 1（epoch 变）
    vi.mocked(sessionManager.getCloseEpoch)
      .mockReturnValueOnce(0) // 入口 baseline
      .mockReturnValue(1); // helper await 后 cancelGuard → 1 !== 0 → abort
    vi.mocked(sessionRepo.get).mockReturnValue(closedRec('sess-await-close'));

    await bridge.sendMessage('sess-await-close', 'hi');

    // 关键：helper isCancelledFn 返 true → aborted → 不起 fresh CLI（否则 ensure 复活 closed）
    expect(bridge.createCalls).toHaveLength(0);
    // abort 不 markClosed（lifecycle 已是用户想要的 closed，close 真发生过无需回滚）
    expect(vi.mocked(sessionManager.markClosed)).not.toHaveBeenCalled();
    // abort 不 emit「自动恢复失败」error（用户主动 close 不是错误）
    const errMsgs = emits.filter(
      (e) => ((e.payload as { text?: string }).text ?? '').includes('自动恢复失败'),
    );
    expect(errMsgs).toHaveLength(0);
  });

  it('③ post-guard 窗口：normal-resume createSession pre-registration close（epoch 变）→ sentinel abort', async () => {
    const bridge = makeBridge();
    // jsonl 在 → 正常 resume 路径;TestBridge createSession 解锁后查 cancelCheck（mirror 真实 MED guard）
    // getCloseEpoch: 入口 baseline 0 → helper isCancelledFn(jsonl 在不进 helper await,但 cancelGuard
    // 仍会被 createSession cancelCheck 调) 返 1。用 mockReturnValueOnce 0 + 其余 1。
    vi.mocked(sessionManager.getCloseEpoch)
      .mockReturnValueOnce(0) // 入口 baseline
      .mockReturnValue(1); // createSession pre-registration cancelCheck → abort
    vi.mocked(sessionRepo.get).mockReturnValue(closedRec('sess-postguard'));

    await bridge.sendMessage('sess-postguard', 'hi');

    // createCalls 记录了 1 次（TestBridge mock 在 push 后才 throw sentinel），但抛了 sentinel → abort
    // 关键：cancelCheck 是函数 + 抛 sentinel 后 outer catch 静默 return（不 emit error / 不 markClosed）
    expect(typeof bridge.createCalls[0]?.cancelCheck).toBe('function');
    expect(vi.mocked(sessionManager.markClosed)).not.toHaveBeenCalled();
    const errMsgs = emits.filter(
      (e) => ((e.payload as { text?: string }).text ?? '').includes('自动恢复失败'),
    );
    expect(errMsgs).toHaveLength(0);
  });

  it('④ concurrent waiter：主 recovery abort（sentinel reject）→ waiter 不 retry / 不 sendThunk', async () => {
    const bridge = makeBridge();
    bridge.createBehavior = 'block'; // 第一波 createSession 阻塞,让 p2 在 inflight 等待者 path arrival
    // jsonl 在 → 走 normal-resume 路径（createSession 被 block 住,p2 进 inflight）。解锁后
    // createSession mock 查 cancelCheck=cancelGuard → epoch 变(1 !== 0) → throw sentinel → p reject。
    vi.mocked(sessionManager.getCloseEpoch)
      .mockReturnValueOnce(0) // p1 入口 baseline（p2 走 inflight path 不捕 baseline）
      .mockReturnValue(1); // createSession pre-registration cancelCheck → 1 !== 0 → sentinel abort
    vi.mocked(sessionRepo.get).mockReturnValue(closedRec('sess-waiter-abort'));

    // 第一波（不 await）注册 inflight,blocked 在 createSession
    const p1 = bridge.sendMessage('sess-waiter-abort', 'first').catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    // 第二波同 sessionId 进 inflight 等待者 path（await 同一个 p）
    const p2 = bridge.sendMessage('sess-waiter-abort', 'second').catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    // createSession 此刻被调一次（blocked,单飞第二条等同一 inflight）
    expect(bridge.createCalls).toHaveLength(1);

    // 解锁 → createSession mock 查 cancelCheck → throw sentinel → p1 reject(sentinel) → p2 waiter
    // special-case 跳过 retry
    bridge.unblock?.();
    await p1;
    await p2;

    // 关键 ④（codex 第 4 点）：主 recovery aborted（sentinel）→ 等待者 special-case 不 retry → 不 sendThunk
    // （否则 sendThunk(sessionId) → 重新触发 recovery 把刚 close 的会话 revive）
    expect(bridge.sendMessageCalls).toHaveLength(0);
    // abort 不 emit「自动恢复失败」（用户主动 close 不是错误）
    const errMsgs = emits.filter(
      (e) => ((e.payload as { text?: string }).text ?? '').includes('自动恢复失败'),
    );
    expect(errMsgs).toHaveLength(0);
  });

  it('⑤ 真 createSession 失败（非 cancel,epoch 不变）→ 仍走 markClosed 回滚 + emit error（回归 REVIEW_76）', async () => {
    const bridge = makeBridge();
    bridge.jsonlExistsOverride = false;
    bridge.createBehavior = 'reject';
    bridge.rejectWith = new Error('SDK spawn failed (real failure, not cancel)');
    // getCloseEpoch 恒 0（无 close）→ cancelGuard 恒 false → 不 abort，createSession 真失败走 generic catch
    vi.mocked(sessionRepo.get).mockReturnValue(closedRec('sess-real-fail'));

    await expect(bridge.sendMessage('sess-real-fail', 'hi')).rejects.toThrow(/real failure/);

    // 真失败（非 sentinel）→ markClosed 回滚（REVIEW_76 行为保留）+ emit 自动恢复失败
    expect(vi.mocked(sessionManager.markClosed)).toHaveBeenCalledWith('sess-real-fail');
    const errMsgs = emits.filter(
      (e) => ((e.payload as { text?: string }).text ?? '').includes('自动恢复失败'),
    );
    expect(errMsgs).toHaveLength(1);
  });

  it('⑥ baseline 在 entry emit 之后捕获 → user message 入 events（abort 不丢用户输入）', async () => {
    const bridge = makeBridge();
    bridge.jsonlExistsOverride = false;
    vi.mocked(sessionManager.getCloseEpoch)
      .mockReturnValueOnce(0)
      .mockReturnValue(1);
    vi.mocked(sessionRepo.get).mockReturnValue(closedRec('sess-emit-then-abort'));

    await bridge.sendMessage('sess-emit-then-abort', 'my input');

    // entry emit user message 在 baseline 捕获之前发出 → 即使随后 abort，用户输入已入 events
    const userMsgs = emits.filter(
      (e) => e.kind === 'message' && (e.payload as { role?: string }).role === 'user',
    );
    expect(userMsgs).toHaveLength(1);
    expect((userMsgs[0].payload as { text: string }).text).toBe('my input');
    // 随后 abort（epoch 变）→ 不起 fresh CLI
    expect(bridge.createCalls).toHaveLength(0);
  });
});

