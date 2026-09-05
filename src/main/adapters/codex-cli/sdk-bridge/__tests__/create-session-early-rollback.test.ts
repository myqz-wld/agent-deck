import * as mcpSessionTokenMap from '@main/agent-deck-mcp/mcp-session-token-map';
import { describe, expect, it, vi } from 'vitest';
import {
  appServerClientMock,
  getInjectedMcpToken,
  makeBridge,
  sessionManager,
  sessionRepo,
} from './create-session-fixture';
describe('codex createSession early-failure rollback (REVIEW_79 test gap)', () => {
  // ── rollback 路径 1: ensureCodex throw（app-server client constructor throw）──────────────────
  it('ensureCodex throw（app-server client 构造失败）→ catch → token released + sessions Map 不残留 + throw 透传', async () => {
    appServerClientMock.constructorThrow = new Error('app-server client boom');

    const bridge = makeBridge();
    const err = await bridge
      .createSession({ cwd: '/repo', prompt: 'hi', resume: 'sess-e1' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/app-server client boom/);
    const token = getInjectedMcpToken();

    // token allocate 发生在 validate phase（throw 前），rollback 必须 release
    expect(mcpSessionTokenMap.get(token)).toBeNull();
    // sessions Map 不残留（resume 路径 sessions.set 在 ensureCodex 之后，此处尚未 set，
    // rollback delete 仍 idempotent no-op 安全）
    const sessions = (bridge as unknown as { sessions: Map<string, unknown> }).sessions;
    expect(sessions.has('sess-e1')).toBe(false);
  });

  // ── rollback 路径 2: resumeThread sync throw ───────────────────────────────────
  it('resumeThread sync throw（SDK 参数校验失败）→ catch → token released + releaseSdkClaim + throw 透传', async () => {
    vi.mocked(sessionRepo.get).mockReturnValue({
      id: 'sess-e2',
      agentId: 'codex-cli',
      cwd: '/repo',
      title: 't',
      source: 'sdk',
      lifecycle: 'dormant',
      activity: 'idle',
      startedAt: 1,
      lastEventAt: 2,
      endedAt: null,
      archivedAt: null,
      codexSandbox: 'workspace-write',
      cliSessionId: 'sess-e2',
    } as unknown as ReturnType<typeof sessionRepo.get>);
    appServerClientMock.resumeThreadSyncThrow = new Error('resumeThread param invalid');

    const bridge = makeBridge();
    const err = await bridge
      .createSession({ cwd: '/repo', prompt: 'hi', resume: 'sess-e2' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/resumeThread param invalid/);
    const token = getInjectedMcpToken();

    // rollback: token released + (resume 路径) releaseSdkClaim(opts.resume)
    expect(mcpSessionTokenMap.get(token)).toBeNull();
    expect(sessionManager.releaseSdkClaim).toHaveBeenCalledWith('sess-e2');
  });
});
