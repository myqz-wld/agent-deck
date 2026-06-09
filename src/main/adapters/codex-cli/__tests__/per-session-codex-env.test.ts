/**
 * codex bridge per-session app-server client + token map integration 单测
 * （plan codex-handoff-team-alignment-20260518 P2 Step 2.10 / TC5-7b）。
 *
 * 覆盖（v4 M2/L2/M7 race / leak case 全覆盖）：
 * - TC5: 多 codex session per-session token 不串 — 用中性变量名 SPIKE_LABEL（v3 L2
 *   修法,避撞 codex LLM 拒读 TOKEN 字样;此处测试不真起子进程,直接验 token allocate
 *   per-session 独立 + 不串）
 * - TC6: 外部 codex CLI fallback 走 globalToken — mcpSessionTokenMap.get(unknown) 返
 *   null → HookServer.checkMcpAuth 比对全局 mcpServerToken → fallbackToGlobal=true
 *   → handler 视为 external caller（D1 §(b)）
 * - TC7: sessionId rename → mcpSessionTokenMap.rename + bridge.renameCodexInstance
 *   在 sessionManager.renameSdkSession 函数体内统一调（不变量 7）— 4 处 key 同步
 *   迁移（sessions Map / sdkOwned / token map / codexBySession Map）
 * - TC7b: session close → token map 应清空 + codexBySession Map 删 entry（M7 内存泄漏）
 *
 * 测试策略：用 TestCodexBridge 强制访问 private codexBySession Map + 注入 fake app-server
 * client（不真 spawn codex 子进程）;sessionManager mock 模拟 renameSdkSession hook 派发;
 * mcpSessionTokenMap 是 module-level singleton 直接用真实模块。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSessionRepoMock } from '@main/__tests__/_shared/mocks/session-repo';
import { makeSettingsStoreMock } from '@main/__tests__/_shared/mocks/settings-store';

// 与 recovery test 同款 6 个入口模块 stub,绕过 vitest node 环境下 electron 模块的 'failed to install'
vi.mock('@main/adapters/codex-cli/sdk-bridge/codex-binary', () => ({
  resolveBundledCodexBinary: () => null,
  resolveCodexBinary: () => null,
  prependResolvedCodexPathDirs: vi.fn(),
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
  sessionRepo: makeSessionRepoMock(),
}));

vi.mock('@main/session/manager', () => ({
  sessionManager: {
    claimAsSdk: vi.fn(),
    releaseSdkClaim: vi.fn(),
    renameSdkSession: vi.fn(),
    unarchive: vi.fn(),
  },
}));

import { sessionManager } from '@main/session/manager';
import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import { emits, makeBridge } from './sdk-bridge/_setup';
import type { CodexAppServerClient } from '@main/adapters/codex-cli/app-server/client';
import type { InternalSession } from '@main/adapters/codex-cli/sdk-bridge/types';

beforeEach(() => {
  emits.length = 0;
  mcpSessionTokenMap.clearAll();
  vi.mocked(sessionManager.releaseSdkClaim).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Make a fake app-server client (no real subprocess) — just an opaque object 给 tests
 * 直接塞进 bridge.codexBySession Map 用于验证 rename / close 操作 Map key。
 */
function makeFakeCodex(label: string): CodexAppServerClient {
  return { __fakeCodexLabel: label, dispose: vi.fn() } as unknown as CodexAppServerClient;
}

function makeInternalSession(threadId: string | null = null): InternalSession {
  return {
    applicationSid: threadId ?? 'sess-test',
    threadId,
    cwd: '/tmp/x',
    thread: {} as InternalSession['thread'],
    pendingMessages: [],
    currentTurn: null,
    currentTurnId: null,
    turnLoopRunning: false,
    intentionallyClosed: false,
  };
}

describe('TC5: 多 codex session per-session token 不串（用中性变量名 SPIKE_LABEL,避撞 v3 L2 codex 拒读 TOKEN 字样）', () => {
  it('两个 sid allocate 拿到不同 token + 各自反查回正确 sid（per-session 隔离不串）', () => {
    const SPIKE_LABEL_A = mcpSessionTokenMap.allocate('codex-teammate-A');
    const SPIKE_LABEL_B = mcpSessionTokenMap.allocate('codex-teammate-B');

    // 两个 token 不同（randomUUID v4 collision 概率 ~2^-122）
    expect(SPIKE_LABEL_A).not.toBe(SPIKE_LABEL_B);

    // 各自反查回正确 sid（不串）
    expect(mcpSessionTokenMap.get(SPIKE_LABEL_A)).toBe('codex-teammate-A');
    expect(mcpSessionTokenMap.get(SPIKE_LABEL_B)).toBe('codex-teammate-B');

    // 释放 A 后 B 仍命中（per-session 独立 release）
    mcpSessionTokenMap.release('codex-teammate-A');
    expect(mcpSessionTokenMap.get(SPIKE_LABEL_A)).toBeNull();
    expect(mcpSessionTokenMap.get(SPIKE_LABEL_B)).toBe('codex-teammate-B');
  });

  it('per-session app-server client Map 独立持各 session entry（bridge.codexBySession 不串）', () => {
    const bridge = makeBridge();
    const codexBySession = (bridge as unknown as { codexBySession: Map<string, CodexAppServerClient> })
      .codexBySession;

    // 模拟两 session 各起独立 app-server client（real ensureCodex 路径会做这件事）
    const codexA = makeFakeCodex('A');
    const codexB = makeFakeCodex('B');
    codexBySession.set('codex-teammate-A', codexA);
    codexBySession.set('codex-teammate-B', codexB);

    // 各自 Map entry 独立
    expect(codexBySession.get('codex-teammate-A')).toBe(codexA);
    expect(codexBySession.get('codex-teammate-B')).toBe(codexB);
    expect(codexBySession.size).toBe(2);
  });
});

describe('TC6: 外部 codex CLI fallback 走 globalToken（mcpSessionTokenMap.get 返 null）', () => {
  it('未 allocate 的 random token → get 返 null（HookServer 应走 fallback 比对全局 mcpServerToken）', () => {
    // 模拟外部 codex CLI（非应用 spawn 路径）走全局 token 调 MCP
    // HookServer.checkMcpAuth 反查 per-session map 不命中 → 比对 mcpServerToken → fallbackToGlobal=true
    const externalToken = 'external-cli-token-xyz';
    expect(mcpSessionTokenMap.get(externalToken)).toBeNull();
    // 注：fallback 到 globalToken + handler 视为 external caller 的部分由 hook-server / tools/index.ts
    // 双方协作（D1 §(b) ADR），transport-http-extra-auth.test.ts TC4b 已覆盖 lambda + makeCallerContext 链路
  });

  it('per-session 已 allocate 的 token + 一个未 allocate 的 token → 前者命中后者 null', () => {
    const sessionToken = mcpSessionTokenMap.allocate('codex-teammate-1');
    expect(mcpSessionTokenMap.get(sessionToken)).toBe('codex-teammate-1');

    // 外部 CLI 用全局 token（与 per-session 不同的字面值），per-session map miss
    const externalGlobalToken = 'global-mcp-server-token-abc';
    expect(mcpSessionTokenMap.get(externalGlobalToken)).toBeNull();
  });
});

describe('TC7: sessionId rename → mcpSessionTokenMap.rename + codexBySession Map rename 在 renameSdkSession 函数体内统一调（不变量 7）', () => {
  it('mcpSessionTokenMap.rename(oldId, newId) → token 字符串不变 + get(token) 切到 newId', () => {
    const oldSid = 'codex-temp-sid';
    const newSid = 'codex-real-thread-id';
    const token = mcpSessionTokenMap.allocate(oldSid);

    // 模拟 sessionManager.renameSdkSession 函数体内调（不变量 7）
    mcpSessionTokenMap.rename(oldSid, newSid);

    // token 字符串本身不变，sid 反查从 oldId 切到 newId
    expect(mcpSessionTokenMap.get(token)).toBe(newSid);
  });

  it('bridge.renameCodexInstance(oldId, newId) → codexBySession Map key 同步迁移', () => {
    const bridge = makeBridge();
    const codexBySession = (bridge as unknown as { codexBySession: Map<string, CodexAppServerClient> })
      .codexBySession;
    const oldSid = 'codex-temp-sid';
    const newSid = 'codex-real-thread-id';

    // 模拟新建路径 ensureCodex(tempKey, token) 把 app-server client 放进 Map
    const codex = makeFakeCodex('initial');
    codexBySession.set(oldSid, codex);

    // 模拟 thread-loop CLI 隐式 fork：realId 拿到 → sessionManager.renameSdkSession 函数体内
    // 派发 hook → bridge.renameCodexInstance（不变量 7 接入点）
    bridge.renameCodexInstance(oldSid, newSid);

    // codexBySession Map 同步迁移：oldSid delete + newSid set 同一 app-server client
    expect(codexBySession.has(oldSid)).toBe(false);
    expect(codexBySession.get(newSid)).toBe(codex);
  });

  it('renameCodexInstance: oldId 不在 Map（claude adapter / 已 release）→ 静默 no-op', () => {
    const bridge = makeBridge();
    const codexBySession = (bridge as unknown as { codexBySession: Map<string, CodexAppServerClient> })
      .codexBySession;

    // 不抛错 + Map 仍空
    expect(() => bridge.renameCodexInstance('never-allocated', 'whatever')).not.toThrow();
    expect(codexBySession.size).toBe(0);
  });

  it('renameCodexInstance: newId 已经在 Map（理论不应发生; 不覆盖防丢已 spawn 子进程引用）', () => {
    const bridge = makeBridge();
    const codexBySession = (bridge as unknown as { codexBySession: Map<string, CodexAppServerClient> })
      .codexBySession;
    const oldSid = 'old';
    const newSid = 'new-existing';

    const codexOld = makeFakeCodex('old');
    const codexNewExisting = makeFakeCodex('new-existing');
    codexBySession.set(oldSid, codexOld);
    codexBySession.set(newSid, codexNewExisting);

    bridge.renameCodexInstance(oldSid, newSid);

    // newSid 现 entry 保留（不覆盖防丢已 spawn 子进程引用），oldSid 保留（rename 不动）
    expect(codexBySession.get(newSid)).toBe(codexNewExisting);
    expect(codexBySession.get(oldSid)).toBe(codexOld);
  });
});

describe('TC7b: session close → token map 应清空 + codexBySession Map 删 entry（M7 内存泄漏）', () => {
  it('closeSession(sid) → codexBySession.delete + mcpSessionTokenMap.release 双轨清理', async () => {
    const bridge = makeBridge();
    const codexBySession = (bridge as unknown as { codexBySession: Map<string, CodexAppServerClient> })
      .codexBySession;
    const sessions = (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions;

    const sid = 'codex-sess-close';
    const token = mcpSessionTokenMap.allocate(sid);
    const codex = makeFakeCodex('to-close');

    // setup 双轨道 state：mcpSessionTokenMap + codexBySession + sessions
    codexBySession.set(sid, codex);
    sessions.set(sid, makeInternalSession(sid));

    // 调真实 closeSession（非 TestCodexBridge override 路径）
    await bridge.closeSession(sid);

    // 双轨道清空：
    // 1. mcpSessionTokenMap.release(sid) → token map 双向 entry 都清
    expect(mcpSessionTokenMap.get(token)).toBeNull();
    // 2. codexBySession Map entry 删
    expect(codexBySession.has(sid)).toBe(false);
    // 3. sessions Map entry 删（既有 closeSession 行为）
    expect(sessions.has(sid)).toBe(false);
    // sessionManager.releaseSdkClaim 被调（fork 后 OLD/NEW 两 key 都试 release，sid 等 threadId 时仅命中一次）
    expect(vi.mocked(sessionManager.releaseSdkClaim)).toHaveBeenCalledWith(sid);
  });

  it('closeSession: sid != threadId（fork 场景）→ 两个 key 都 release（边角覆盖）', async () => {
    const bridge = makeBridge();
    const codexBySession = (bridge as unknown as { codexBySession: Map<string, CodexAppServerClient> })
      .codexBySession;
    const sessions = (bridge as unknown as { sessions: Map<string, InternalSession> }).sessions;

    const tempKey = 'temp-key';
    const realThreadId = 'real-thread-id';

    // 模拟 fork 场景：sessions Map 用 tempKey 索引,但 internal.threadId 是 realThreadId
    const internal = makeInternalSession(realThreadId);
    sessions.set(tempKey, internal);

    // 双 key 都 allocate token + 放 codex（fork 场景边角覆盖）
    const tokenTemp = mcpSessionTokenMap.allocate(tempKey);
    const tokenReal = mcpSessionTokenMap.allocate(realThreadId);
    codexBySession.set(tempKey, makeFakeCodex('temp'));
    codexBySession.set(realThreadId, makeFakeCodex('real'));

    await bridge.closeSession(tempKey);

    // 双 key 都清（覆盖 sub-step 2.5d 边角注释:sessionId == realId / threadId == realId 同款
    // 不会双删;但 sessionId != threadId 时双 key 都需 release 防内存泄漏）
    expect(mcpSessionTokenMap.get(tokenTemp)).toBeNull();
    expect(mcpSessionTokenMap.get(tokenReal)).toBeNull();
    expect(codexBySession.has(tempKey)).toBe(false);
    expect(codexBySession.has(realThreadId)).toBe(false);
  });

  it('closeSession: sid 不在 sessions Map → 直接 return（不清 token / codexBySession，防误删别 session）', async () => {
    const bridge = makeBridge();
    const codexBySession = (bridge as unknown as { codexBySession: Map<string, CodexAppServerClient> })
      .codexBySession;

    // 别 session 在 codexBySession + token map（不应被本次 close 误删）
    const otherSid = 'other-session';
    const otherToken = mcpSessionTokenMap.allocate(otherSid);
    codexBySession.set(otherSid, makeFakeCodex('other'));

    // close 一个 sessions Map 没有的 sid（已 close / 从未建过）
    await bridge.closeSession('nonexistent-sid');

    // 别 session 的 token + codex 保留（closeSession 早 return 不进 cleanup 块）
    expect(mcpSessionTokenMap.get(otherToken)).toBe(otherSid);
    expect(codexBySession.has(otherSid)).toBe(true);
  });
});

describe('TC8 (bonus): setCodexCliPath → codexBySession Map clear 整个（已 spawn 子进程不受影响）', () => {
  it('setCodexCliPath 清整 Map（v4 P2 Sub-step 2.5e 重组）', () => {
    const bridge = makeBridge();
    const codexBySession = (bridge as unknown as { codexBySession: Map<string, CodexAppServerClient> })
      .codexBySession;

    // setup: 3 个 session 各持 app-server client
    codexBySession.set('s1', makeFakeCodex('s1'));
    codexBySession.set('s2', makeFakeCodex('s2'));
    codexBySession.set('s3', makeFakeCodex('s3'));
    expect(codexBySession.size).toBe(3);

    // setCodexCliPath 触发 clear 整 Map（替代修前 `this.codex = null` 单实例字段重组）
    bridge.setCodexCliPath('/new/codex/path');

    // Map 清空,但已 spawn 的子进程 envOverride 已 frozen 拷贝到子进程 env（spike 2 §1 实证）,
    // 这里测试范围:Map 清空让下次 ensureCodex 重建实例（已 spawn 子进程独立运行不受影响）
    expect(codexBySession.size).toBe(0);
  });
});
