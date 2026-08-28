import { describe, expect, it, vi } from 'vitest';
import { AgentDeckClientErrorCode, type SessionConsoleAttachmentInput } from '@contracts/index';
import type {
  StoredAgentEvent,
  UploadedAttachmentRef,
} from '@shared/types';
import {
  runtimeCoreHarness as harness,
  runtimeCoreInput as input,
  runtimeCoreRecord as record,
} from './runtime-core.test-fixture';

describe('ServerCoreDaemonRuntime', () => {
  it('starts once and stops once', async () => {
    const { runtime, start, stop } = harness();
    await Promise.all([runtime.start(), runtime.start()]);
    expect(start).toHaveBeenCalledOnce();
    await Promise.all([runtime.stop('test'), runtime.stop('again')]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('serves health and bounded history without cwd disclosure', async () => {
    const event: StoredAgentEvent = {
      id: 7,
      sessionId: 'session-a',
      agentId: 'claude-code',
      kind: 'message',
      payload: { role: 'user', text: 'hello' },
      ts: 12,
      source: 'sdk',
    };
    const { runtime } = harness({ events: [event, { ...event, id: 8, ts: 13 }] });
    await runtime.start();
    await expect(runtime.execute(input('system.health', {}))).resolves.toEqual({
      result: { ok: true, revision: 0 }, revision: 0,
    });
    const history = await runtime.execute(input('session.history', {
      sessionId: 'session-a', limit: 1,
    }));
    expect(history.result).toEqual({
      entries: [{
        id: 'event-7', sessionId: 'session-a', sequence: 7,
        role: 'user', content: 'hello', createdAt: 12,
      }],
      nextCursor: 'v1:history:1',
      revision: 0,
    });
    expect(JSON.stringify(history.result)).not.toContain('/workspaces/private');
  });

  it('deduplicates accepted sends and never persists the message body in metadata', async () => {
    const { metadata, runtime, sendMessage } = harness();
    await runtime.start();
    const request = input('session.send', { sessionId: 'session-a', text: 'secret body' }, {
      idempotencyKey: 'intent-a',
    });
    const first = await runtime.execute(request);
    const replay = await runtime.execute(request);
    expect(replay).toEqual(first);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      'session-a', 'secret body', undefined, { idempotencyKey: 'intent-a' },
    );
    expect(JSON.stringify(metadata.changes)).not.toContain('secret body');
    await expect(runtime.execute(input('session.send', {
      sessionId: 'session-a', text: 'different',
    }, { idempotencyKey: 'intent-a' }))).rejects.toMatchObject({ code: 'conflict' });
  });

  it('persists Remote image attachments once and forwards only Worker-owned references', async () => {
    const attachment: SessionConsoleAttachmentInput = {
      kind: 'image', mime: 'image/png', bytes: 1, base64: 'YQ==',
    };
    const stored: UploadedAttachmentRef = {
      kind: 'uploaded', mime: 'image/png', bytes: 1, path: '/private/image.png',
    };
    const persist = vi.fn(async () => [stored]);
    const remove = vi.fn(async () => undefined);
    const { runtime, sendMessage } = harness({
      adapter: { capabilities: { canAcceptAttachments: true } as never },
      attachmentStore: { persist, remove },
    });
    await runtime.start();
    const request = input('session.send', {
      sessionId: 'session-a', text: '', attachments: [attachment],
    }, { idempotencyKey: 'attachment-intent' });
    const first = await runtime.execute(request);
    await expect(runtime.execute(request)).resolves.toEqual(first);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledWith([attachment]);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      'session-a', '', [stored], { idempotencyKey: 'attachment-intent' },
    );
    expect(remove).not.toHaveBeenCalled();
  });

  it('removes persisted Remote attachments when provider acceptance fails', async () => {
    const attachment: SessionConsoleAttachmentInput = {
      kind: 'image', mime: 'image/png', bytes: 1, base64: 'YQ==',
    };
    const stored: UploadedAttachmentRef = {
      kind: 'uploaded', mime: 'image/png', bytes: 1, path: '/private/image.png',
    };
    const remove = vi.fn(async () => undefined);
    const { runtime } = harness({
      adapter: {
        capabilities: { canAcceptAttachments: true } as never,
        sendMessage: vi.fn(async () => { throw new Error('provider rejected'); }),
      },
      attachmentStore: { persist: vi.fn(async () => [stored]), remove },
    });
    await runtime.start();
    await expect(runtime.execute(input('session.send', {
      sessionId: 'session-a', text: 'inspect', attachments: [attachment],
    }, { idempotencyKey: 'attachment-failure' }))).rejects.toThrow('provider rejected');
    expect(remove).toHaveBeenCalledWith([stored]);
  });

  it('publishes runtime-bound context/input capabilities and steers active images', async () => {
    const attachment: SessionConsoleAttachmentInput = {
      kind: 'image', mime: 'image/png', bytes: 1, base64: 'YQ==',
    };
    const stored: UploadedAttachmentRef = {
      kind: 'uploaded', mime: 'image/png', bytes: 1, path: '/private/steer.png',
    };
    const steerTurn = vi.fn(async () => undefined);
    const { runtime } = harness({
      session: record({
        contextUsage: {
          usedTokens: 321,
          windowTokens: 1_000_000,
          updatedAt: 45,
          runtimeIdentity: {
            version: 1,
            runtimeKey: 'claude-code:deepseek:model',
            adapter: 'claude-code',
            runtimeProvider: 'deepseek',
            model: 'deepseek-v4-flash[1m]',
            capacityConfigFingerprint: 'capacity-a',
          },
        },
      }),
      adapter: {
        capabilities: { canAcceptAttachments: true } as never,
        listSessionCommands: vi.fn(async () => [{
          name: 'compact', description: '压缩上下文', argumentHint: '', aliases: [],
        }]),
        steerTurn,
      },
      attachmentStore: {
        persist: vi.fn(async () => [stored]),
        remove: vi.fn(async () => undefined),
      },
    });
    await runtime.start();
    await expect(runtime.execute(input('session.context.get', { sessionId: 'session-a' })))
      .resolves.toMatchObject({
        result: { contextUsage: { usedTokens: 321, windowTokens: 1_000_000 }, revision: 0 },
      });
    await expect(runtime.execute(input(
      'session.input.capabilities',
      { sessionId: 'session-a' },
    ))).resolves.toMatchObject({
      result: {
        adapterId: 'claude-code',
        activeTurn: { mode: 'queue', attachments: { enabled: true } },
        commands: [{ name: 'compact' }],
      },
    });
    await runtime.execute(input('session.steer', {
      sessionId: 'session-a', text: 'inspect', attachments: [attachment],
    }, { idempotencyKey: 'steer-image' }));
    expect(steerTurn).toHaveBeenCalledWith('session-a', 'inspect', [stored]);
  });

  it('publishes and enforces the selected session runtime attachment negotiation', async () => {
    const attachment: SessionConsoleAttachmentInput = {
      kind: 'image', mime: 'image/png', bytes: 1, base64: 'YQ==',
    };
    const persist = vi.fn();
    const sendMessage = vi.fn();
    const steerTurn = vi.fn();
    const { runtime } = harness({
      session: record({ agentId: 'grok-build' }),
      adapter: {
        capabilities: { canAcceptAttachments: true } as never,
        canAcceptSessionAttachments: vi.fn(() => false),
        sendMessage,
        steerTurn,
      },
      attachmentStore: { persist, remove: vi.fn() },
    });
    await runtime.start();

    await expect(runtime.execute(input(
      'session.input.capabilities', { sessionId: 'session-a' },
    ))).resolves.toMatchObject({
      result: { activeTurn: { mode: 'interject', attachments: { enabled: false } } },
    });
    await expect(runtime.execute(input('session.send', {
      sessionId: 'session-a', text: 'inspect', attachments: [attachment],
    }, { idempotencyKey: 'session-image-send' }))).rejects.toMatchObject({
      code: AgentDeckClientErrorCode.CapabilityUnavailable,
    });
    await expect(runtime.execute(input('session.steer', {
      sessionId: 'session-a', text: 'inspect', attachments: [attachment],
    }, { idempotencyKey: 'session-image-steer' }))).rejects.toMatchObject({
      code: AgentDeckClientErrorCode.CapabilityUnavailable,
    });
    expect(persist).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(steerTurn).not.toHaveBeenCalled();
  });

  it('lists and idempotently removes a path-free redacted provider queue item', async () => {
    const queued = {
      id: 'queued-a',
      text: 'token=sk-secretmarker123; inspect .claude/settings.json',
      attachments: [{
        kind: 'uploaded' as const,
        path: '/private/queued.png',
        mime: 'image/png',
        bytes: 8,
      }],
    };
    const removePendingOutgoingMessage = vi.fn(async () => queued);
    const { runtime } = harness({
      adapter: {
        listPendingOutgoingMessages: () => [queued],
        removePendingOutgoingMessage,
      },
    });
    await runtime.start();
    const listed = await runtime.execute(input('session.outgoing.list', {
      sessionId: 'session-a',
    }));
    expect(listed.result).toMatchObject({
      sessionId: 'session-a',
      messages: [{
        id: 'queued-a',
        text: 'token=[敏感内容已省略]; inspect [敏感内容已省略]',
        attachments: [{ id: 'queued-a:0', mime: 'image/png', bytes: 8 }],
      }],
    });
    expect(JSON.stringify(listed.result)).not.toContain('/private/queued.png');
    const request = input('session.outgoing.remove', {
      sessionId: 'session-a', messageId: 'queued-a',
    }, { idempotencyKey: 'remove-queued-a' });
    const first = await runtime.execute(request);
    await expect(runtime.execute(request)).resolves.toEqual(first);
    expect(removePendingOutgoingMessage).toHaveBeenCalledOnce();
  });

});
