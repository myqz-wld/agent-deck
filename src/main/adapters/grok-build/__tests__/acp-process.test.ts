import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { methods } from '@agentclientprotocol/sdk';

import { GrokAcpProcess } from '../acp-process';

const fixture = fileURLToPath(
  new URL('./fixtures/fake-grok-acp-agent.mjs', import.meta.url),
);

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

    await expect(
      GrokAcpProcess.start({
        binary: globalThis.process.execPath,
        args: [fixture, '--auth=grok.com'],
        cwd: globalThis.process.cwd(),
        onSessionUpdate: () => undefined,
        onPermissionRequest: vi.fn(async () => ({
          outcome: { outcome: 'cancelled' as const },
        })),
      }),
    ).rejects.toThrow(/grok login --oauth/);
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

  it('delivers Grok extension notifications separately from standard ACP updates', async () => {
    const updates: unknown[] = [];
    const child = await GrokAcpProcess.start({
      binary: globalThis.process.execPath,
      args: [fixture],
      cwd: globalThis.process.cwd(),
      onSessionUpdate: () => undefined,
      onGrokExtensionUpdate: (notification) => updates.push(notification),
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
      });
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        sessionId: created.sessionId,
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'fake-prompt-1',
          usage: { inputTokens: 7, outputTokens: 5 },
        },
      });
    } finally {
      await child.stop();
    }
  });
});
