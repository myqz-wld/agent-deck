import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { methods } from '@agentclientprotocol/sdk';

import { GrokAcpProcess } from '../acp-process';

const fixture = fileURLToPath(
  new URL('./fixtures/fake-grok-acp-agent.mjs', import.meta.url),
);

describe('GrokAcpProcess', () => {
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
});
