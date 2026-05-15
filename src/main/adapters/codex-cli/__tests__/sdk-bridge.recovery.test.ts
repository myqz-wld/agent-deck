/**
 * codex sdk-bridge.recoverAndSend 单测（codex-tests-plan P1 Step 1.2）。
 *
 * 镜像 claude `__tests__/sdk-bridge.recovery.test.ts` 同款覆盖矩阵但适配 codex 形态：
 * - codex 没有 permissionMode（SDK approvalPolicy 写死 'never'）
 * - codex per-session 沙盒字段 = `codexSandbox`（不是 claudeCodeSandbox）
 * - codex 还有 `model` 字段（fallback 路径需透传 sessionRepo.model 否则 DB / spawn 不一致）
 * - codex jsonl missing emit text = "Codex 内部对话历史 (jsonl) 已不存在"（不是 claude 的「CLI 内部对话历史(jsonl)已丢失」）
 * - codex cwd fallback emit text = "已切到 fallback (...) 继续 (对话历史保留)"（R2-2 修法 — codex jsonl 独立于 cwd）
 * - codex 没有 LLM 摘要 prepend（详 recoverer.ts L29-33；shared helper 与 claude 耦合留 follow-up）
 *
 * 覆盖：sendMessage 检测 sessions Map 没有该 sessionId 时的「断连自愈」路径，重点：
 *   - HIGH-B：sessions Map miss → recoverer.recoverAndSend 端到端（resume 主路径 / jsonl missing fallback）
 *   - MED-E：jsonl pre-check（避免 SDK 抛 "Codex Exec exited with ..." 后字符串匹配）
 *   - LOW-A：cwd 失效启发式 fallback（K2 老 session worktree 删 / parent walk）
 *   - 单飞 / placeholder 5s dedup / MAX_MESSAGE_LENGTH / archived → unarchive
 *   - codexSandbox + model 透传（与 claude HIGH-1 同款防 fallback 路径静默降级）
 *
 * Mock 策略（与 claude recovery test 同款，hoisted vi.mock 必须每个文件独立写）：
 *   - sessionRepo / sessionManager / sdk-loader 全 mock
 *   - 子类化 CodexSdkBridge 覆盖 createSession 不真起 codex CLI 子进程，避免本机 vitest spawn 真 codex binary
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';
import { makeBareSdkLoaderMock } from '@main/__tests__/_shared/mocks/sdk-loader';
import { makeSettingsStoreMock } from '@main/__tests__/_shared/mocks/settings-store';

// codex bridge index.ts top-level 导入链上有几条间接 import 'electron'/electron-store 的路径,
// 在 vitest node 环境下都会炸:
// 1. ./codex-binary.ts → import { app } from 'electron'
// 2. @main/store/image-uploads → @main/paths → import { app } from 'electron'
// 3. @main/store/settings-store → import Store from 'electron-store'(electron-store 内部又拉 electron)
// 与 claude `sdk-injection` mock 同款方式把入口模块 stub 成 no-op，电源就断了
// (TestBridge override createSession 后这些被 mock 的方法实际不会被调用，仅满足 module load)。
vi.mock('@main/adapters/codex-cli/sdk-bridge/codex-binary', () => ({
  resolveBundledCodexBinary: () => null,
}));
vi.mock('@main/store/image-uploads', () => ({
  deleteUploadIfExists: vi.fn(async () => undefined),
}));
vi.mock('@main/paths', () => ({
  getImageUploadsDir: () => '/tmp/test-image-uploads',
}));
vi.mock('@main/store/settings-store', () => ({
  settingsStore: makeSettingsStoreMock(),
}));
// agent-deck-mcp-injector 不直接 import electron 但走 settings-store 链，独立 mock 防意外
vi.mock('@main/codex-config/agent-deck-mcp-injector', () => ({
  buildAgentDeckMcpConfigForCodex: () => null,
  mergeCodexConfig: (a: unknown) => a,
}));
// codex-instance-pool 的 invalidateCodexInstance 在 setCodexCliPath 时被调，TestBridge 不走这条
vi.mock('@main/adapters/codex-cli/codex-instance-pool', () => ({
  invalidateCodexInstance: vi.fn(),
}));

// sessionRepo / sdk-loader 走 _shared/mocks/ factory；sessionRepo.get 用 vi.fn override 让 caller
// 在 beforeEach mockReset / mockReturnValue 切换 fixture（与 claude test 同款）。
vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({
    overrides: { get: vi.fn() },
  }),
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    claimAsSdk: vi.fn(),
    releaseSdkClaim: vi.fn(),
    renameSdkSession: vi.fn(),
    unarchive: vi.fn(),
  },
}));

vi.mock('@main/adapters/codex-cli/sdk-loader', () => makeBareSdkLoaderMock());

import { sessionRepo } from '@main/store/session-repo';
import { sessionManager } from '@main/session/manager';
import { emits, makeBridge } from './sdk-bridge/_setup';

beforeEach(() => {
  emits.length = 0;
  vi.mocked(sessionRepo.get).mockReset();
  vi.mocked(sessionManager.renameSdkSession).mockReset();
  vi.mocked(sessionManager.unarchive).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('codex sdk-bridge.sendMessage 断连自愈（symmetry-plan P2 HIGH-B）', () => {
  it('record 在 + jsonl 在 → 走 createSession({resume,prompt,cwd,codexSandbox,model}) + emit 占位 message', async () => {
    const bridge = makeBridge();
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-1',
      agentId: 'codex-cli',
      cwd: '/tmp/work',
      title: 'work',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      codexSandbox: 'workspace-write',
      model: 'gpt-5',
    });

    await bridge.sendMessage('sess-1', 'hi');

    // 占位 message（非 error）emit 一条 — 文案 "Codex 通道已断开，正在自动恢复"
    const placeholders = emits.filter(
      (e) =>
        e.kind === 'message' &&
        typeof (e.payload as { text?: string }).text === 'string' &&
        (e.payload as { text: string }).text.includes('正在自动恢复'),
    );
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0].sessionId).toBe('sess-1');
    expect((placeholders[0].payload as { error?: boolean }).error).toBeFalsy();

    // createSession 被调一次,resume 主路径透传所有字段
    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0]).toMatchObject({
      cwd: '/tmp/work',
      prompt: 'hi',
      resume: 'sess-1',
      codexSandbox: 'workspace-write',
      model: 'gpt-5',
    });
  });

  it('record 不在 → 抛 not found，createSession 不被调，不 emit placeholder', async () => {
    const bridge = makeBridge();
    vi.mocked(sessionRepo.get).mockReturnValue(null);

    await expect(bridge.sendMessage('sess-ghost', 'hi')).rejects.toThrow(/not found/);
    expect(bridge.createCalls).toHaveLength(0);
    // 没记录 = 真不可恢复，不污染活动流
    const placeholders = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('正在自动恢复'),
    );
    expect(placeholders).toHaveLength(0);
  });

  it('单飞：同 sessionId 并发 sendMessage 只触发一次 createSession（HIGH-A 共享 recovering Map）', async () => {
    const bridge = makeBridge();
    bridge.createBehavior = 'block';
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-2',
      agentId: 'codex-cli',
      cwd: '/tmp/x',
      title: 'x',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
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
    bridge.rejectWith = new Error('codex CLI auth expired');
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-3',
      agentId: 'codex-cli',
      cwd: '/tmp/y',
      title: 'y',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
    });

    await expect(bridge.sendMessage('sess-3', 'hi')).rejects.toThrow(/codex CLI auth expired/);

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

  it('jsonl 不存在 → fallback 走不带 resume 的 createSession + emit jsonl missing info（MED-E + CHANGELOG_28 同款）', async () => {
    const bridge = makeBridge();
    bridge.jsonlExistsOverride = false; // 模拟 ~/.codex/sessions/.../<sid>.jsonl 不在
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-no-jsonl',
      agentId: 'codex-cli',
      cwd: '/tmp/abandoned',
      title: 'abandoned',
      source: 'sdk',
      lifecycle: 'closed',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: 3,
      archivedAt: null,
      codexSandbox: 'read-only',
      model: 'gpt-5-codex',
    });

    await bridge.sendMessage('sess-no-jsonl', 'hi');

    // createSession 被调一次,**不带 resume** — 走新建 thread 路径
    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0]).toMatchObject({
      cwd: '/tmp/abandoned',
      prompt: 'hi',
      resume: undefined, // 关键：fallback 路径不带 resume
      // codexSandbox + model 仍要透传（HIGH-1 同款防静默降级）
      codexSandbox: 'read-only',
      model: 'gpt-5-codex',
    });

    // 占位 message 仍 emit（用户体感「在自动恢复」）
    const placeholders = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('正在自动恢复'),
    );
    expect(placeholders).toHaveLength(1);

    // emit jsonl missing info — codex 文案与 claude 不同（"Codex 内部对话历史 (jsonl) 已不存在"）
    const jsonlLostInfo = emits.filter((e) => {
      const p = e.payload as { text?: string; error?: boolean };
      return (p.text ?? '').includes('Codex 内部对话历史 (jsonl) 已不存在');
    });
    expect(jsonlLostInfo).toHaveLength(1);
    expect(jsonlLostInfo[0].sessionId).toBe('sess-no-jsonl');
    // info 性质,不打 error: true(与 claude 路径一致)
    expect((jsonlLostInfo[0].payload as { error?: boolean }).error).not.toBe(true);
    // 文案断言:fresh thread + 历史保留 + 提示用户补背景
    expect((jsonlLostInfo[0].payload as { text: string }).text).toMatch(/fresh thread|背景/);
  });

  it('jsonl 不存在 + handle.sessionId !== sessionId → 调 renameSdkSession(OLD, NEW)', async () => {
    const bridge = makeBridge();
    bridge.jsonlExistsOverride = false;
    // TestBridge override createSession 在 fallback 路径(无 resume)返回 'new-sid'(默认)
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-rename',
      agentId: 'codex-cli',
      cwd: '/tmp/rename',
      title: 'x',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
    });

    await bridge.sendMessage('sess-rename', 'hi');

    // recoverer 主体在 jsonl missing 路径 + handle.sessionId !== sessionId 时调 renameSdkSession 把
    // 应用层 events / file_changes / summaries 子表迁到 NEW_ID 名下（CHANGELOG_28 同款）
    expect(sessionManager.renameSdkSession).toHaveBeenCalledWith('sess-rename', 'new-sid');
  });

  // ─── archived session → unarchive + recover（CHANGELOG_31 同款） ──────────

  it('archived session → 自动 unarchive + recover（用户显式发消息触发）', async () => {
    const bridge = makeBridge();
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-archived',
      agentId: 'codex-cli',
      cwd: '/tmp/archived',
      title: 'x',
      source: 'sdk',
      lifecycle: 'closed',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: 3,
      archivedAt: 4, // ← 关键：archived
    });

    await bridge.sendMessage('sess-archived', 'hi');

    // unarchive 被调（用户显式发消息 = 表达「我又要聊它了」）
    expect(sessionManager.unarchive).toHaveBeenCalledWith('sess-archived');
    // createSession 仍走 resume 主路径（unarchive 后正常自愈）
    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0].resume).toBe('sess-archived');
  });

  // ─── MAX_MESSAGE_LENGTH（防恢复路径绕过 cap） ──────────

  it('text 超 MAX_MESSAGE_LENGTH → 抛错，createSession 不被调', async () => {
    const bridge = makeBridge();
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-toolong',
      agentId: 'codex-cli',
      cwd: '/tmp/x',
      title: 'x',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
    });

    const tooLong = 'a'.repeat(102_401); // 102_400 = MAX_MESSAGE_LENGTH

    await expect(bridge.sendMessage('sess-toolong', tooLong)).rejects.toThrow(/超过.*字符上限/);
    expect(bridge.createCalls).toHaveLength(0);
  });

  // ─── 5s placeholder dedup（REVIEW_17 R3 同款） ──────────

  it('5s 内同 sessionId 反复 recover → 只 emit 1 次 placeholder（dedup）', async () => {
    const bridge = makeBridge();
    bridge.createBehavior = 'reject';
    bridge.rejectWith = new Error('first wave fail');
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-dedup',
      agentId: 'codex-cli',
      cwd: '/tmp/x',
      title: 'x',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
    });

    // 第 1 次 — emit placeholder + recover 失败
    await expect(bridge.sendMessage('sess-dedup', 'first')).rejects.toThrow(/first wave fail/);
    // 第 2 次（5s 内同 sid）— 不应再 emit placeholder
    bridge.rejectWith = new Error('second wave fail');
    await expect(bridge.sendMessage('sess-dedup', 'second')).rejects.toThrow(/second wave fail/);

    const placeholders = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('正在自动恢复'),
    );
    // 仅 1 次（dedup 起作用）
    expect(placeholders).toHaveLength(1);
  });

  // ─── CHANGELOG_99 cwd 失效启发式 fallback (LOW-A) ──────────

  it('CHANGELOG_99: cwd 不存在 + .claude/worktrees/ 启发式命中 → fallback main repo + R2-2 保留对话历史（jsonl 在）', async () => {
    const bridge = makeBridge();
    // Map mock: dead worktree path 不存在 + main repo 存在 → 启发式 1 命中
    bridge.cwdExistsOverride = new Map<string, boolean>([
      ['/Users/apple/myrepo/.claude/worktrees/dead-plan', false],
      ['/Users/apple/myrepo', true],
    ]);
    // jsonl 仍在(默认 true) — R2-2 修法:cwd fallback 不再强制 fresh thread,可保留对话历史
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-cwd-bad',
      agentId: 'codex-cli',
      cwd: '/Users/apple/myrepo/.claude/worktrees/dead-plan',
      title: 'x',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: 3,
      archivedAt: null,
      codexSandbox: 'workspace-write',
    });

    await bridge.sendMessage('sess-cwd-bad', 'hi');

    // R2-2 修法：cwd fallback 但 jsonl 在 → createSession 走 resume 主路径用 fallback cwd
    // (codex jsonl 完全独立于 cwd,date-based 路径,详 recoverer.ts L38-40 + L186-188 注释)
    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0]).toMatchObject({
      cwd: '/Users/apple/myrepo', // 启发式 1 命中
      prompt: 'hi',
      resume: 'sess-cwd-bad', // ← R2-2 关键: cwdFellBack 不再强制 undefined,jsonl 在则保留 resume
      codexSandbox: 'workspace-write',
    });

    // emit 一条 info message(不打 error)告诉用户 fallback 发生 + "对话历史保留"
    const fallbackInfo = emits.filter((e) => {
      const p = e.payload as { text?: string };
      return (p.text ?? '').includes('已切到 fallback');
    });
    expect(fallbackInfo).toHaveLength(1);
    expect((fallbackInfo[0]!.payload as { error?: boolean }).error).not.toBe(true);
    expect((fallbackInfo[0]!.payload as { text: string }).text).toContain('/Users/apple/myrepo');
    // R2-2 文案断言:必须强调对话历史保留(修前错说"fresh thread 开始"自相矛盾)
    expect((fallbackInfo[0]!.payload as { text: string }).text).toContain('对话历史保留');

    // placeholder 也 emit(用户体感"在自动恢复")
    const placeholders = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('正在自动恢复'),
    );
    expect(placeholders).toHaveLength(1);

    // jsonl 在 → 不 emit jsonl missing info(codex jsonl 独立于 cwd 关键证据)
    const jsonlLostInfo = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('jsonl) 已不存在'),
    );
    expect(jsonlLostInfo).toHaveLength(0);
  });

  it('CHANGELOG_99: cwd 不存在 + 启发式全 miss → emit error + throw,不进 placeholder 路径', async () => {
    const bridge = makeBridge();
    // Map 全 false → 启发式 1 (main repo 不存在) + 启发式 2 (parent walk 全部不存在) 全 miss
    bridge.cwdExistsOverride = new Map<string, boolean>(); // 空 Map = 任何路径都返 false
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-no-rescue',
      agentId: 'codex-cli',
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
      return p.error === true && (p.text ?? '').includes('cwd 不存在且无可用 fallback');
    });
    expect(errorMessages).toHaveLength(1);

    // **不**emit placeholder「正在自动恢复」(误导)
    const placeholders = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('正在自动恢复'),
    );
    expect(placeholders).toHaveLength(0);

    // 关键 R1 fix MED-2:cwd fallback 失败必须**不**unarchive(否则 archived session 被错误激活但实际死路一条)
    expect(sessionManager.unarchive).not.toHaveBeenCalled();
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
      agentId: 'codex-cli',
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
    // R2-2: jsonl 在 → 仍走 resume 路径
    expect(bridge.createCalls[0]?.resume).toBe('sess-walk');
  });

  it('CHANGELOG_99 + R2-2: cwd 不存在 + jsonl 也不在 → 走 fresh thread 兜底（不 resume）', async () => {
    const bridge = makeBridge();
    // 双不命中: cwd fallback 仍找到, 但 jsonl 也丢了 → 走 fresh thread fallback
    bridge.cwdExistsOverride = new Map<string, boolean>([
      ['/Users/apple/myrepo/.claude/worktrees/dead-plan', false],
      ['/Users/apple/myrepo', true],
    ]);
    bridge.jsonlExistsOverride = false;
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-dual-bad',
      agentId: 'codex-cli',
      cwd: '/Users/apple/myrepo/.claude/worktrees/dead-plan',
      title: 'x',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: 3,
      archivedAt: null,
    });

    await bridge.sendMessage('sess-dual-bad', 'hi');

    // jsonl 也不在 → R2-2 修法仍允许 fresh thread fallback（!jsonlExistsThunk 分支命中）
    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0]).toMatchObject({
      cwd: '/Users/apple/myrepo', // 启发式 1 命中的 fallback cwd
      resume: undefined, // jsonl 不在强制 fresh thread
    });
    // 同时应该 emit 两条 info: cwd fallback + jsonl missing
    const cwdInfo = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('已切到 fallback'),
    );
    const jsonlInfo = emits.filter((e) =>
      ((e.payload as { text?: string }).text ?? '').includes('jsonl) 已不存在'),
    );
    expect(cwdInfo).toHaveLength(1);
    expect(jsonlInfo).toHaveLength(1);
  });

  it('CHANGELOG_99: cwd 存在 → 不触发 fallback,走原 resume 主路径(回归保护)', async () => {
    const bridge = makeBridge();
    // cwdExistsOverride 默认 true,不需显式设
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-ok',
      agentId: 'codex-cli',
      cwd: '/tmp/x',
      title: 'x',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: 3,
      archivedAt: null,
      codexSandbox: 'read-only',
    });

    await bridge.sendMessage('sess-ok', 'hi');

    // createSession 走原 resume 主路径
    expect(bridge.createCalls).toHaveLength(1);
    expect(bridge.createCalls[0]).toMatchObject({
      cwd: '/tmp/x',
      prompt: 'hi',
      resume: 'sess-ok',
      codexSandbox: 'read-only',
    });

    // **不**emit cwd fallback info message
    const fallbackInfo = emits.filter((e) => {
      const p = e.payload as { text?: string };
      return (p.text ?? '').includes('已切到 fallback');
    });
    expect(fallbackInfo).toHaveLength(0);
  });

  // ─── HIGH-1 等价: codexSandbox + model 透传回归 ────────
  //
  // 与 claude REVIEW_36 HIGH-1 同款逻辑：fallback 路径若漏传 record.codexSandbox / model,
  // 会让 sandbox-resolve 走 settingsStore 全局值静默降级；DB record 仍显示原 codexSandbox/model
  // 但实际 spawn 用全局默认 = 行为/数据脱钩。

  it('HIGH-1 等价: jsonl 不存在 + record codexSandbox=danger-full-access → fallback 透传', async () => {
    const bridge = makeBridge();
    bridge.jsonlExistsOverride = false;
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-danger',
      agentId: 'codex-cli',
      cwd: '/tmp/sandboxed',
      title: 'danger-session',
      source: 'sdk',
      lifecycle: 'closed',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: 3,
      archivedAt: null,
      codexSandbox: 'danger-full-access',
      model: 'gpt-5-pro',
    });

    await bridge.sendMessage('sess-danger', 'hi');

    expect(bridge.createCalls).toHaveLength(1);
    // 关键断言：fallback 路径必须把 record.codexSandbox + model 透传给 createThunk
    expect(bridge.createCalls[0].codexSandbox).toBe('danger-full-access');
    expect(bridge.createCalls[0].model).toBe('gpt-5-pro');
  });
});
