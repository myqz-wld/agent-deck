/**
 * codex receiveTeammateMessage E2E wire prefix 端到端测试
 * （plan codex-handoff-team-alignment-20260518 P2 Step 2.11 / TC8）。
 *
 * 测试目标：universal-message-watcher.buildWireBody 构造的 cross-session message wire
 * prefix `[from <name> @ <adapter>][msg <id>][sid <senderSid>]\n<body>` 通过 codex
 * receiveTeammateMessage → bridge.sendMessage → pendingMessages 队列 → 发到 codex SDK
 * 子进程的整条链路上**字节级保留**（codex 子进程 prompt 顶部能看到双锚点 wire prefix
 * 调 `mcp__agent-deck__send_message({reply_to_message_id: msgId, ...})` 回 lead）。
 *
 * 覆盖（plan §P2 Step 2.11）：
 * - TC8a: bridge.sendMessage(sid, wireBody) → pendingMessages 末位 = wireBody verbatim（plain
 *   text Input 形态：codex SDK packCodexInput 不带 attachments 直接返回 string）
 * - TC8b: bridge.sendMessage emit kind='message' / payload.text=wireBody verbatim / role='user'
 * - TC8c: shared/wire-prefix.parseWirePrefix 端到端能从 pendingMessages entry / emit text 中
 *   提取出 from / adapter / msgId / senderSessionId 四字段（与 buildWireBody 双向闭环）
 * - TC8d: 双锚点 regex `[msg <id>][sid <senderSid>]` charset 严格 lowercase hex + hyphen 36 字符
 *   （wire format invariant，与 app CLAUDE.md §wire format id invariant 对齐）
 * - TC8e: 多 codex teammate session 各自 pendingMessages 不串（隔离验证 — wire prefix 隔离 +
 *   sessions Map 隔离双轨道）
 *
 * 测试策略：用 TestCodexBridge 强制访问 private sessions Map 注入 fake InternalSession
 * （绕过 createSession 真起 codex 子进程）+ 直接调 `bridge.sendMessage(sid, wireBody)`
 * 模拟 universal-message-watcher.deliver 的下游路径。adapter.receiveTeammateMessage
 * 是 thin wrapper（codex-cli/index.ts:122 `await this.bridge.sendMessage(sid, body)`），
 * bridge 行为正确即等价于 adapter 端到端正确。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';
import { makeBareSdkLoaderMock } from '@main/__tests__/_shared/mocks/sdk-loader';
import { makeSettingsStoreMock } from '@main/__tests__/_shared/mocks/settings-store';

// 与 recovery / consume-fork test 同款 6 个入口模块 stub,绕过 vitest node 环境下 electron 模块的
// 'failed to install'（codex bridge index.ts top-level 导入链上有几条间接 import 'electron' 的路径）
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
vi.mock('@main/codex-config/agent-deck-mcp-injector', () => ({
  buildAgentDeckMcpConfigForCodex: () => null,
  mergeCodexConfig: (a: unknown) => a,
  // plan P2 Step 2.5b: ensureCodex 用此常量当 env key
  AGENT_DECK_MCP_TOKEN_ENV: 'AGENT_DECK_MCP_TOKEN',
}));
vi.mock('@main/adapters/codex-cli/codex-instance-pool', () => ({
  invalidateCodexInstance: vi.fn(),
}));

vi.mock('@main/store/session-repo', () => ({
  sessionRepo: makeSessionRepoMock({}),
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

import { emits, makeBridge } from './sdk-bridge/_setup';
import { parseWirePrefix } from '@shared/wire-prefix';
import type { Thread, Input } from '@openai/codex-sdk';
import type { InternalSession } from '@main/adapters/codex-cli/sdk-bridge/types';

beforeEach(() => {
  emits.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * 构造一个 fake Thread (runStreamed 不会被 sendMessage 路径直接调,但 turnLoop 会;此处
 * pendingMessages.push 后 turnLoopRunning=true 跳过启动 turn loop,fake thread 不真用)。
 */
function makeFakeThread(): Thread {
  return {
    runStreamed: vi.fn(async () => {
      throw new Error('not invoked in this test');
    }),
  } as unknown as Thread;
}

function makeInternalSession(threadId: string): InternalSession {
  return {
    applicationSid: threadId,
    threadId,
    cwd: '/tmp/codex-cwd',
    thread: makeFakeThread(),
    pendingMessages: [],
    currentTurn: null,
    // **关键**:turnLoopRunning=true → bridge.sendMessage 跳过 void runTurnLoop 启动
    // (本 test 不验证 turn loop 行为,只关心 wire prefix 在 pendingMessages 与 emit 中的保留)
    turnLoopRunning: true,
    intentionallyClosed: false,
  };
}

/**
 * 构造一条与 universal-message-watcher.buildWireBody 输出形态字节级对齐的 wire body
 * （buildWireBody 原文：`[from ${displayName} @ ${adapterId}][msg ${id}][sid ${fromSid}]\n${body}`）。
 *
 * 测试用真实 randomUUID 形态 messageId / senderSessionId 验证 charset regex（plan §wire format
 * id invariant：lowercase hex + hyphen 36 字符）。
 */
function buildClaudeLeadToCodexTeammateWireBody(opts: {
  displayName: string;
  msgId: string;
  senderSid: string;
  body: string;
}): string {
  return `[from ${opts.displayName} @ claude-code][msg ${opts.msgId}][sid ${opts.senderSid}]\n${opts.body}`;
}

describe('TC8 codex receiveTeammateMessage E2E wire prefix（claude lead → codex teammate dispatch）', () => {
  it('TC8a: bridge.sendMessage(sid, wireBody) → pendingMessages 末位 = wireBody verbatim（plain text Input 形态）', async () => {
    const bridge = makeBridge();
    const sessions = (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions;
    const sid = 'codex-teammate-1';
    sessions.set(sid, makeInternalSession(sid));

    const wireBody = buildClaudeLeadToCodexTeammateWireBody({
      displayName: 'Lead-Alpha',
      msgId: 'b3eb9b6a-1234-4abc-8def-aabbccddeeff',
      senderSid: 'fa00fa11-fa22-4abc-8def-fa33fa44fa55',
      body: '请帮我 review 这个 PR',
    });

    await bridge.sendMessage(sid, wireBody);

    const internal = sessions.get(sid)!;
    expect(internal.pendingMessages).toHaveLength(1);
    // packCodexInput 纯文本路径直接返回 string（input-pack.ts:28 `if (!attachments) return text`）
    const lastInput: Input = internal.pendingMessages[0];
    expect(typeof lastInput).toBe('string');
    expect(lastInput).toBe(wireBody);
    // 显式断言：wire prefix 三段 + 双锚点字段都 byte-level 一致
    expect(lastInput).toMatch(/^\[from Lead-Alpha @ claude-code\]\[msg [0-9a-f-]{36}\]\[sid [0-9a-f-]{36}\]\n请帮我 review 这个 PR$/);
  });

  it('TC8b: bridge.sendMessage emit kind="message" / payload.text=wireBody verbatim / role="user"', async () => {
    const bridge = makeBridge();
    const sessions = (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions;
    const sid = 'codex-teammate-2';
    sessions.set(sid, makeInternalSession(sid));

    const wireBody = buildClaudeLeadToCodexTeammateWireBody({
      displayName: 'Lead-Beta',
      msgId: 'aaaa1111-bbbb-4ccc-8ddd-eeeeffff0000',
      senderSid: '11112222-3333-4444-8555-666677778888',
      body: '检查 P2 Step 2.5 的 sid 时序',
    });

    await bridge.sendMessage(sid, wireBody);

    const messageEvents = emits.filter((e) => e.kind === 'message' && e.sessionId === sid);
    expect(messageEvents).toHaveLength(1);
    const msg = messageEvents[0];
    const payload = msg.payload as { text: string; role: string; attachments?: unknown };
    // text 字节级 = wireBody（含 wire prefix）— renderer 端通过 parseWirePrefix 拆 chip vs body
    expect(payload.text).toBe(wireBody);
    expect(payload.role).toBe('user');
    // 纯文本 message 不应含 attachments 字段
    expect(payload.attachments).toBeUndefined();
    // event 元字段
    expect(msg.source).toBe('sdk');
    expect(msg.agentId).toBe('codex-cli');
  });

  it('TC8c: shared/wire-prefix.parseWirePrefix 端到端能从 pendingMessages entry / emit text 提取四字段（与 buildWireBody 双向闭环）', async () => {
    const bridge = makeBridge();
    const sessions = (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions;
    const sid = 'codex-teammate-3';
    sessions.set(sid, makeInternalSession(sid));

    const fixture = {
      displayName: 'Lead-Gamma',
      msgId: 'cafe1234-5678-4abc-8def-deadbeef1111',
      senderSid: '0bad5eed-9876-4321-8aaa-bbbbccccdddd',
      body: '帮忙跑测试',
    };
    const wireBody = buildClaudeLeadToCodexTeammateWireBody(fixture);

    await bridge.sendMessage(sid, wireBody);

    // 从 pendingMessages 提取（codex 子进程实际看到的形态）
    const internal = sessions.get(sid)!;
    const pendingText = internal.pendingMessages[0] as string;
    const fromPending = parseWirePrefix(pendingText);
    expect(fromPending).not.toBeNull();
    expect(fromPending?.from).toBe(fixture.displayName);
    expect(fromPending?.adapter).toBe('claude-code');
    expect(fromPending?.msgId).toBe(fixture.msgId);
    expect(fromPending?.senderSessionId).toBe(fixture.senderSid);
    expect(fromPending?.body).toBe(fixture.body);

    // 从 emit text 提取（renderer 端实际看到的形态 — 渲染 chip + body 拆分）
    const messageEvents = emits.filter((e) => e.kind === 'message' && e.sessionId === sid);
    const emitText = (messageEvents[0].payload as { text: string }).text;
    const fromEmit = parseWirePrefix(emitText);
    expect(fromEmit).toEqual(fromPending); // pendingMessages / emit 两条路径解析出同一个对象（双向闭环）
  });

  it('TC8d: 双锚点 charset 严格 lowercase hex + hyphen 36 字符（wire format id invariant，app CLAUDE.md 规约）', async () => {
    const bridge = makeBridge();
    const sessions = (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions;
    const sid = 'codex-teammate-4';
    sessions.set(sid, makeInternalSession(sid));

    const wireBody = buildClaudeLeadToCodexTeammateWireBody({
      displayName: 'Lead-Delta',
      msgId: '01234567-89ab-4cde-8f01-23456789abcd',
      senderSid: 'fedcba98-7654-4321-8000-deadbeefcafe',
      body: '...',
    });

    await bridge.sendMessage(sid, wireBody);

    const pendingText = sessions.get(sid)!.pendingMessages[0] as string;
    // app CLAUDE.md §wire format id invariant：messageId 是 v4 randomUUID；
    // senderSessionId 由 SDK / CLI 分配，不承诺 v4，但同为 lowercase hex + hyphen 36 字符。
    const ANCHOR_RE = /\[msg ([0-9a-f-]{36})\]\[sid ([0-9a-f-]{36})\]/;
    const m = ANCHOR_RE.exec(pendingText);
    expect(m).not.toBeNull();
    const [, msgIdMatch, sidMatch] = m!;
    const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const UUID_36_RE = /^[0-9a-f-]{36}$/;
    expect(msgIdMatch).toMatch(UUID_V4_RE);
    expect(sidMatch).toMatch(UUID_36_RE);
  });

  it('TC8e: 多 codex teammate session 各自 pendingMessages 不串（wire prefix 隔离 + sessions Map 隔离双轨道）', async () => {
    const bridge = makeBridge();
    const sessions = (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions;
    const sidA = 'codex-teammate-A';
    const sidB = 'codex-teammate-B';
    sessions.set(sidA, makeInternalSession(sidA));
    sessions.set(sidB, makeInternalSession(sidB));

    const wireBodyA = buildClaudeLeadToCodexTeammateWireBody({
      displayName: 'Lead-A-only',
      msgId: 'aaaaaaaa-1111-4222-8333-444444444444',
      senderSid: '99999999-8888-4777-8666-555555555555',
      body: 'A-only-text',
    });
    const wireBodyB = buildClaudeLeadToCodexTeammateWireBody({
      displayName: 'Lead-B-only',
      msgId: 'bbbbbbbb-2222-4333-8444-555555555555',
      senderSid: '88888888-7777-4666-8555-444444444444',
      body: 'B-only-text',
    });

    await bridge.sendMessage(sidA, wireBodyA);
    await bridge.sendMessage(sidB, wireBodyB);

    // 各自 pendingMessages 独立持自己 wireBody（不串）
    const internalA = sessions.get(sidA)!;
    const internalB = sessions.get(sidB)!;
    expect(internalA.pendingMessages).toHaveLength(1);
    expect(internalB.pendingMessages).toHaveLength(1);
    expect(internalA.pendingMessages[0]).toBe(wireBodyA);
    expect(internalB.pendingMessages[0]).toBe(wireBodyB);

    // emit 也各自独立带 sessionId 区分（不会把 wireBodyA 误派发给 sidB）
    const messagesForA = emits.filter((e) => e.kind === 'message' && e.sessionId === sidA);
    const messagesForB = emits.filter((e) => e.kind === 'message' && e.sessionId === sidB);
    expect(messagesForA).toHaveLength(1);
    expect(messagesForB).toHaveLength(1);
    expect((messagesForA[0].payload as { text: string }).text).toBe(wireBodyA);
    expect((messagesForB[0].payload as { text: string }).text).toBe(wireBodyB);
  });
});

describe('TC8 codex receiveTeammateMessage 边角', () => {
  it('sanitizeWireFieldName-like 显示名（含数字 / 中文 / 空格） → wireBody 仍能字节级保留 + parseWirePrefix 仍能 parse', async () => {
    // 注：sanitizeWireFieldName 在 buildWireBody 内做（删 ] / \n / [，trim 空白），fromBody 保
    // 留所有合法字符。本测试不重复 sanitize 行为（已由 wire-prefix.test.ts 覆盖），仅验证
    // 已 sanitize 后的合法字段经 codex pipeline 仍 verbatim。
    const bridge = makeBridge();
    const sessions = (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions;
    const sid = 'codex-teammate-edge';
    sessions.set(sid, makeInternalSession(sid));

    const fixture = {
      displayName: 'Lead Reviewer 中文 v2',
      msgId: '01234567-1234-4567-8901-234567890abc',
      senderSid: 'abcdef01-2345-4678-89ab-cdef01234567',
      body: '请审查 src/main/store/session-repo.ts:1-100 line range 改动',
    };
    const wireBody = buildClaudeLeadToCodexTeammateWireBody(fixture);

    await bridge.sendMessage(sid, wireBody);

    const pendingText = sessions.get(sid)!.pendingMessages[0] as string;
    expect(pendingText).toBe(wireBody);
    const parsed = parseWirePrefix(pendingText);
    expect(parsed?.from).toBe(fixture.displayName);
    expect(parsed?.body).toBe(fixture.body);
  });

  it('attachments 透传：bridge.sendMessage(sid, wireBody, [...refs]) → pendingMessages UserInput[] 形态（包 wireBody 为 type:text item）', async () => {
    const bridge = makeBridge();
    const sessions = (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions;
    const sid = 'codex-teammate-attach';
    sessions.set(sid, makeInternalSession(sid));

    const wireBody = buildClaudeLeadToCodexTeammateWireBody({
      displayName: 'Lead-Attach',
      msgId: 'cafedeed-1234-4567-8901-234567890abc',
      senderSid: 'abcdef01-2345-4678-89ab-cdef01234567',
      body: '看这张图',
    });
    const attachments = [
      { kind: 'uploaded' as const, path: '/tmp/x.png', mime: 'image/png', bytes: 1024 },
    ];

    await bridge.sendMessage(sid, wireBody, attachments);

    const internal = sessions.get(sid)!;
    expect(internal.pendingMessages).toHaveLength(1);
    const lastInput = internal.pendingMessages[0];
    // 带 attachments → packCodexInput 返 UserInput[]，[local_image, ..., text] 顺序（input-pack.ts:28-37）
    expect(Array.isArray(lastInput)).toBe(true);
    const items = lastInput as Array<{ type: string; text?: string; path?: string }>;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: 'local_image', path: '/tmp/x.png' });
    // wireBody 包成 type:text item 字节级保留（codex 子进程仍能从 text 顶部 parse wire prefix）
    expect(items[1]).toMatchObject({ type: 'text', text: wireBody });
  });
});
