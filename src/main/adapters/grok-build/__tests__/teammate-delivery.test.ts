import { describe, expect, it, vi } from 'vitest';
import type { GrokAcpSession } from '../acp-process';
import { GrokBuildAdapter, type GrokBuildAdapterHost } from '../adapter-core';
import { GrokBuildBridge } from '../bridge';
import { createGrokRuntime } from '../runtime-factory';
import type { GrokRuntime } from '../runtime-types';
import { createTestGrokBridgeRuntimeHost } from './bridge-runtime-fixture';

function fixture() {
  const request = vi.fn(async (..._args: unknown[]) => ({ status: 'queued' }));
  const runtime = createGrokRuntime('receiver', { cwd: '/workspace', prompt: '' }, null);
  runtime.nativeSessionId = 'native-session';
  runtime.process = {
    connection: { agent: { request } },
    initializeResponse: { agentCapabilities: {} },
  } as unknown as GrokAcpSession;
  runtime.ready = true;
  runtime.running = true;
  const emit = vi.fn();
  const hasPendingWorktreeTransition = vi.fn(() => false);
  const bridge = new GrokBuildBridge({
    runtimeHost: createTestGrokBridgeRuntimeHost({ hasPendingWorktreeTransition }),
    emit,
    permissionTimeoutMs: 0,
    mcpHttpUrl: 'http://127.0.0.1:1234/mcp',
    isAgentDeckMcpEnabled: () => false,
    getAgentProfilePrompt: async () => null,
    getPluginDirectories: async () => [],
    sessionManager: {
      claimAsSdk: vi.fn(), releaseSdkClaim: vi.fn(), delete: vi.fn(),
      markClosed: vi.fn(), updateCliSessionId: vi.fn(),
    },
    reportStartupCleanupFailure: vi.fn(),
  });
  (bridge as unknown as { runtimes: Map<string, GrokRuntime> }).runtimes.set('receiver', runtime);
  const adapter = new GrokBuildAdapter({} as GrokBuildAdapterHost);
  (adapter as unknown as { bridge: GrokBuildBridge }).bridge = bridge;
  const body = '[from Teammate @ claude-code][msg wire-1][sid sender]\nUse the latest result';
  const send = () => adapter.receiveTeammateMessage('receiver', 'sender', body, 'wire-1');
  return { runtime, request, emit, body, send, hasPendingWorktreeTransition };
}

describe('Grok teammate delivery through the adapter and ACP bridge', () => {
  it('interjects during the active turn and deduplicates delivery retries', async () => {
    const f = fixture();
    await f.send();
    await vi.waitFor(() => expect(f.runtime.submittingMessage).toBeNull());
    await f.send();

    expect(f.request).toHaveBeenCalledOnce();
    expect(f.request).toHaveBeenCalledWith(
      '_x.ai/interject',
      expect.objectContaining({ sessionId: 'native-session', text: f.body }),
      expect.anything(),
    );
    expect(f.runtime.running).toBe(true);
    expect(f.runtime.queue).toEqual([]);
    expect(f.emit).toHaveBeenCalledOnce();
    expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'message', payload: expect.objectContaining({ role: 'user', text: f.body }),
    }));
  });

  it('retains one queued message when the provider lacks the interjection extension', async () => {
    const f = fixture();
    f.request.mockRejectedValueOnce(Object.assign(new Error('Method not found'), { code: -32601 }));
    await f.send();
    await vi.waitFor(() => expect(f.runtime.interjectionSupported).toBe(false));
    await f.send();

    expect(f.request).toHaveBeenCalledOnce();
    expect(f.runtime.queue).toHaveLength(1);
    expect(f.runtime.queue[0]?.text).toBe(f.body);
    expect(f.runtime.running).toBe(true);
  });

  it('respects the worktree transition gate', async () => {
    const f = fixture();
    f.hasPendingWorktreeTransition.mockReturnValue(true);
    await f.send();

    expect(f.request).not.toHaveBeenCalled();
    expect(f.runtime.queue).toHaveLength(1);
    expect(f.runtime.queue[0]?.text).toBe(f.body);
  });
});
