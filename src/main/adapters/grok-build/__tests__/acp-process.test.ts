import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { methods } from '@agentclientprotocol/sdk';

import { GrokAcpProcess, withTimeout } from '../acp-process';

const fixture = fileURLToPath(
  new URL('./fixtures/fake-grok-acp-agent.mjs', import.meta.url),
);

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    throw new Error('expected promise to reject');
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error.message;
  }
}

describe('GrokAcpProcess', () => {
  it('authenticates before session/new and prefers API key over cached token', async () => {
    const child = await GrokAcpProcess.start({
      binary: globalThis.process.execPath,
      args: [fixture, '--auth=cached_token,xai.api_key'],
      cwd: globalThis.process.cwd(),
      onSessionUpdate: () => undefined,
      onPermissionRequest: vi.fn(async () => ({
        outcome: { outcome: 'cancelled' as const },
      })),
    });

    try {
      expect(child.authenticatedMethodId).toBe('xai.api_key');
      await expect(
        child.connection.agent.request(methods.agent.session.new, {
          cwd: globalThis.process.cwd(),
          mcpServers: [],
        }),
      ).resolves.toMatchObject({ sessionId: 'fake-native-session' });
    } finally {
      await child.stop();
    }
  });

  it('uses cached login and rejects an interactive-only ACP child with a next action', async () => {
    const cached = await GrokAcpProcess.start({
      binary: globalThis.process.execPath,
      args: [fixture, '--auth=cached_token'],
      cwd: globalThis.process.cwd(),
      onSessionUpdate: () => undefined,
      onPermissionRequest: vi.fn(async () => ({
        outcome: { outcome: 'cancelled' as const },
      })),
    });
    expect(cached.authenticatedMethodId).toBe('cached_token');
    await cached.stop();

    expect(
      await rejectionMessage(
        GrokAcpProcess.start({
          binary: globalThis.process.execPath,
          args: [fixture, '--auth=grok.com'],
          cwd: globalThis.process.cwd(),
          onSessionUpdate: () => undefined,
          onPermissionRequest: vi.fn(async () => ({
            outcome: { outcome: 'cancelled' as const },
          })),
        }),
      ),
    ).toBe(
      'Grok Build ACP 需要交互式认证（grok.com）。请在终端运行 "grok login --oauth"，或通过 ~/.grok/config.toml 和导出的环境变量配置 API key，然后重启 Agent Deck。',
    );
  });

  it('uses exact Grok Build copy for ACP timeout', async () => {
    expect(
      await rejectionMessage(
        withTimeout(
          new Promise<never>(() => undefined),
          1,
          'Grok Build ACP initialize',
        ),
      ),
    ).toBe('Grok Build ACP initialize 在 1ms 后超时');
  });

  it('reports the final authenticate failure without changing method ids or recovery commands', async () => {
    expect(
      await rejectionMessage(
        GrokAcpProcess.start({
          binary: globalThis.process.execPath,
          args: [
            fixture,
            '--auth=xai.api_key,cached_token',
            '--fail-auth=xai.api_key,cached_token',
          ],
          cwd: globalThis.process.cwd(),
          onSessionUpdate: () => undefined,
          onPermissionRequest: vi.fn(async () => ({
            outcome: { outcome: 'cancelled' as const },
          })),
        }),
      ),
    ).toBe(
      'Grok Build ACP authenticate 对 "xai.api_key"、"cached_token" 均失败：Internal error。请运行 "grok login --oauth"，或确认 ~/.grok/config.toml 中为 API key 配置的 env_key 已由登录 shell 导出。',
    );
  });

  it('falls back to cached login when API-key authentication is advertised but unavailable', async () => {
    const child = await GrokAcpProcess.start({
      binary: globalThis.process.execPath,
      args: [
        fixture,
        '--auth=xai.api_key,cached_token',
        '--fail-auth=xai.api_key',
      ],
      cwd: globalThis.process.cwd(),
      onSessionUpdate: () => undefined,
      onPermissionRequest: vi.fn(async () => ({
        outcome: { outcome: 'cancelled' as const },
      })),
    });
    expect(child.authenticatedMethodId).toBe('cached_token');
    await child.stop();
  });

  it('runs initialize/new/prompt/cancel over deterministic ACP stdio', async () => {
    const updates: string[] = [];
    const child = await GrokAcpProcess.start({
      binary: globalThis.process.execPath,
      args: [fixture],
      cwd: globalThis.process.cwd(),
      onSessionUpdate: (notification) => {
        if (
          notification.update.sessionUpdate === 'agent_message_chunk' &&
          notification.update.content.type === 'text'
        ) {
          updates.push(notification.update.content.text);
        }
      },
      onPermissionRequest: vi.fn(async () => ({
        outcome: { outcome: 'cancelled' as const },
      })),
    });

    try {
      expect(
        child.initializeResponse.agentCapabilities?.promptCapabilities?.image,
      ).toBe(true);
      const created = await child.connection.agent.request(
        methods.agent.session.new,
        { cwd: globalThis.process.cwd(), mcpServers: [] },
      );
      const response = await child.connection.agent.request(
        methods.agent.session.prompt,
        {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'hello' }],
        },
      );
      expect(response).toMatchObject({
        stopReason: 'end_turn',
        usage: { inputTokens: 7, outputTokens: 5 },
      });
      expect(updates).toEqual(['echo:hello']);
      await expect(
        child.connection.agent.request<
          { modelId: string; reasoningEffort: string | null },
          {
            sessionId: string;
            modelId: string;
            _meta: { reasoningEffort: string };
          }
        >('session/set_model', {
          sessionId: created.sessionId,
          modelId: 'fake-model-2',
          _meta: { reasoningEffort: 'high' },
        }),
      ).resolves.toEqual({
        modelId: 'fake-model-2',
        reasoningEffort: 'high',
      });
      await expect(
        child.connection.agent.request(methods.agent.session.setMode, {
          sessionId: created.sessionId,
          modeId: 'plan',
        }),
      ).resolves.toEqual({});
      await child.connection.agent.notify(methods.agent.session.cancel, {
        sessionId: created.sessionId,
      });
    } finally {
      await child.stop();
    }

    expect(child.child.exitCode ?? child.child.signalCode).not.toBeNull();
  });

  it('keeps consuming ACP after an application session-update callback throws', async () => {
    const updateErrors: unknown[] = [];
    const updates: string[] = [];
    let failFirstUpdate = true;
    const child = await GrokAcpProcess.start({
      binary: globalThis.process.execPath,
      args: [fixture],
      cwd: globalThis.process.cwd(),
      onSessionUpdate: (notification) => {
        if (failFirstUpdate) {
          failFirstUpdate = false;
          throw new Error('simulated persistence failure');
        }
        if (
          notification.update.sessionUpdate === 'agent_message_chunk'
          && notification.update.content.type === 'text'
        ) {
          updates.push(notification.update.content.text);
        }
      },
      onSessionUpdateError: (error) => updateErrors.push(error),
      onPermissionRequest: vi.fn(async () => ({
        outcome: { outcome: 'cancelled' as const },
      })),
    });

    try {
      const created = await child.connection.agent.request(
        methods.agent.session.new,
        { cwd: globalThis.process.cwd(), mcpServers: [] },
      );
      await expect(
        child.connection.agent.request(methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'survive callback failure' }],
        }),
      ).resolves.toMatchObject({ stopReason: 'end_turn' });
      expect(updateErrors).toHaveLength(1);
      expect(updateErrors[0]).toBeInstanceOf(Error);
      expect(updates).toEqual(['echo:survive callback failure']);
    } finally {
      await child.stop();
    }
  });

  it('sends ACP extension requests with the underscore wire prefix', async () => {
    const child = await GrokAcpProcess.start({
      binary: globalThis.process.execPath,
      args: [fixture],
      cwd: globalThis.process.cwd(),
      onSessionUpdate: () => undefined,
      onPermissionRequest: vi.fn(async () => ({
        outcome: { outcome: 'cancelled' as const },
      })),
    });

    try {
      const created = await child.connection.agent.request(
        methods.agent.session.new,
        { cwd: globalThis.process.cwd(), mcpServers: [] },
      );
      await expect(
        child.connection.agent.request('_x.ai/interject', {
          sessionId: created.sessionId,
          text: 'insert while running',
          interjectionId: 'interjection-1',
          content: [{ type: 'text', text: 'insert while running' }],
        }),
      ).resolves.toEqual({ status: 'queued' });
    } finally {
      await child.stop();
    }
  });

  it('round-trips permission requests through the client callback', async () => {
    const updates: string[] = [];
    const onPermissionRequest = vi.fn(async () => ({
      outcome: { outcome: 'selected' as const, optionId: 'allow' },
    }));
    const child = await GrokAcpProcess.start({
      binary: globalThis.process.execPath,
      args: [fixture],
      cwd: globalThis.process.cwd(),
      onSessionUpdate: (notification) => {
        if (
          notification.update.sessionUpdate === 'agent_message_chunk' &&
          notification.update.content.type === 'text'
        ) {
          updates.push(notification.update.content.text);
        }
      },
      onPermissionRequest,
    });

    try {
      const created = await child.connection.agent.request(
        methods.agent.session.new,
        { cwd: globalThis.process.cwd(), mcpServers: [] },
      );
      await child.connection.agent.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'permission please' }],
      });
      expect(onPermissionRequest).toHaveBeenCalledOnce();
      expect(updates).toEqual(['permission:allow']);
    } finally {
      await child.stop();
    }
  });

  it('delivers both Grok extension wire variants and prompt-complete over ACP', async () => {
    const updates: unknown[] = [];
    const completions: unknown[] = [];
    const child = await GrokAcpProcess.start({
      binary: globalThis.process.execPath,
      args: [fixture],
      cwd: globalThis.process.cwd(),
      onSessionUpdate: () => undefined,
      onGrokExtensionUpdate: (notification) => updates.push(notification),
      onGrokPromptComplete: (notification) => completions.push(notification),
      onPermissionRequest: vi.fn(async () => ({
        outcome: { outcome: 'cancelled' as const },
      })),
    });

    try {
      const created = await child.connection.agent.request(methods.agent.session.new, {
        cwd: globalThis.process.cwd(),
        mcpServers: [],
      });
      await child.connection.agent.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'extension' }],
        _meta: { turnId: 42 },
      });
      await child.connection.agent.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'text', text: 'session_notification extension' }],
        _meta: { turnId: 43 },
      });
      expect(updates).toHaveLength(2);
      expect(updates[0]).toMatchObject({
        sessionId: created.sessionId,
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'fake-prompt-1',
          usage: { inputTokens: 7, outputTokens: 5 },
        },
      });
      expect(updates[1]).toMatchObject({
        sessionId: created.sessionId,
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'fake-prompt-2',
        },
      });
      await vi.waitFor(() => expect(completions).toEqual([
        {
          sessionId: created.sessionId,
          promptId: 'fake-prompt-1',
          stopReason: 'end_turn',
          agentResult: null,
          turnId: 42,
        },
        {
          sessionId: created.sessionId,
          promptId: 'fake-prompt-2',
          stopReason: 'end_turn',
          agentResult: null,
          turnId: 43,
        },
      ]));
    } finally {
      await child.stop();
    }
  });
});
