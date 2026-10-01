import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRemoteHostAskQuestionDisplay } from '@shared/remote-host';
import { ServerCoreMcpPresentation } from './mcp-presentation';
import { createServerCoreMcpServer } from './mcp-server';
import { cleanupMcpServerHarnesses, createMcpServerHarness } from './mcp-server.test-fixture';
import { structuredPayload, withClient } from './mcp-server-test-client';
import { listServerCorePendingRequests, respondToServerCorePending } from './runtime-pending';
import type { AgentAdapter } from '@main/adapters/types';
import type { JsonValue } from '@contracts/index';

afterEach(() => { cleanupMcpServerHarnesses(); vi.useRealTimers(); });
const args = { questions: [{ question: 'Choose scope', options: [{ label: 'Local' }, { label: 'Remote' }] }, { question: 'Constraints?' }] };

describe('Server Core ask_user', () => {
  it('removes Pending when the MCP client cancels the in-flight tool call', async () => {
    const { host } = createMcpServerHarness();
    const service = new ServerCoreMcpPresentation({ appendChange: vi.fn() });
    await service.start();
    const server = await createServerCoreMcpServer({ ...host, presentations: service }, () => 'caller-a', 'codex-cli', { McpServer });
    try {
      await withClient(server, async (client) => {
        const controller = new AbortController();
        const pending = client.callTool({ name: 'ask_user', arguments: args }, undefined, { signal: controller.signal });
        const rejection = expect(pending).rejects.toBeDefined();
        await vi.waitFor(() => expect(service.list('caller-a')).toHaveLength(1));
        controller.abort();
        await rejection;
        await vi.waitFor(() => expect(service.list('caller-a')).toEqual([]));
      });
    } finally { await service.stop(); }
  });

  it.each(['claude-code', 'codex-cli', 'grok-build'] as const)(
    'round-trips %s questions through MCP, Pending and structured answers', async (adapterId) => {
      const { host, records } = createMcpServerHarness();
      records.get('caller-a')!.agentId = adapterId;
      const service = new ServerCoreMcpPresentation({ appendChange: vi.fn() });
      await service.start();
      const server = await createServerCoreMcpServer({ ...host, presentations: service }, () => 'caller-a', adapterId, { McpServer });
      try {
        await withClient(server, async (client) => {
          const pending = client.callTool({ name: 'ask_user', arguments: args });
          await vi.waitFor(() => expect(service.list('caller-a')).toHaveLength(1));
          const adapter = {} as AgentAdapter;
          const [request] = listServerCorePendingRequests(adapter, 'caller-a', 1, service);
          expect(request).toMatchObject({ kind: 'ask-user-question', expiresAt: null });
          expect(parseRemoteHostAskQuestionDisplay(request!.display)?.questions[1].options).toEqual([]);
          await expect(respondToServerCorePending(adapter, {
            sessionId: 'caller-a', requestId: request!.id, action: 'submit',
            value: { q1: { selected: ['Local'], note: 'First phase' }, q2: 'Keep credentials local' },
          }, service)).resolves.toBe('resolved');
          expect(structuredPayload(await pending)).toEqual({ status: 'answered', answers: [
            { question: 'Choose scope', selected: ['Local'], note: 'First phase' },
            { question: 'Constraints?', selected: [], other: 'Keep credentials local' },
          ] });
          expect(service.list('caller-a')).toEqual([]);
        });
      } finally { await service.stop(); }
    },
  );

  it('retains questions after rejected answers, ignores wrong owners, and rejects duplicate submissions', async () => {
    const service = new ServerCoreMcpPresentation({ appendChange: vi.fn() });
    await service.start();
    const pending = service.requestAsk('session-a', args);
    const [request] = service.list('session-a');
    expect(service.respond('session-b', request!.id, 'submit', { q1: ['Local'], q2: 'Answer' })).toBeNull();
    const invalidValues: JsonValue[] = [
      { q1: ['Local'] },
      { q1: ['Local', 'Remote'], q2: 'Answer' },
      { q1: ['forged'], q2: 'Answer' },
      { q1: { selected: [] }, q2: { selected: [] } },
      { q1: ['Local'], q2: 'x'.repeat(4_097) },
    ];
    for (const value of invalidValues) expect(() => service.respond('session-a', request!.id, 'submit', value)).toThrow();
    expect(() => service.respond('session-a', request!.id, 'accept')).toThrow();
    expect(service.list('session-a')).toHaveLength(1);
    service.respond('session-a', request!.id, 'submit', { q1: ['Local'], q2: { selected: [] } });
    expect((await pending).answers[1]).toEqual({ question: 'Constraints?', selected: [] });
    expect(service.respond('session-a', request!.id, 'submit', {})).toBeNull();
    await service.stop();
  });

  it('cancels on abort, close and committed handoff, with rollback preserving the source question', async () => {
    const service = new ServerCoreMcpPresentation({ appendChange: vi.fn() });
    await service.start();
    const controller = new AbortController();
    const aborted = service.requestAsk('session-a', args, controller.signal);
    controller.abort();
    await expect(aborted).resolves.toEqual({ status: 'cancelled', answers: [] });
    expect(service.list('session-a')).toEqual([]);
    const transferred = service.requestAsk('session-a', args);
    service.prepareSessionTransfer('session-a', 'session-b').rollback();
    expect(service.list('session-a')).toHaveLength(1);
    service.prepareSessionTransfer('session-a', 'session-b').commit();
    await expect(transferred).resolves.toEqual({ status: 'cancelled', answers: [] });
    expect(service.list('session-b')).toEqual([]);
    const closed = service.requestAsk('session-a', args);
    service.releaseSession('session-a');
    await expect(closed).resolves.toEqual({ status: 'cancelled', answers: [] });
    const stopped = service.requestAsk('session-a', args);
    await service.stop();
    await expect(stopped).resolves.toEqual({ status: 'cancelled', answers: [] });
  });

  it('waits indefinitely while live and publishes no request for an aborted or invalid call', async () => {
    vi.useFakeTimers();
    const appendChange = vi.fn();
    const service = new ServerCoreMcpPresentation({ appendChange });
    await service.start();
    const controller = new AbortController(); controller.abort();
    await expect(service.requestAsk('session-a', args, controller.signal)).resolves.toMatchObject({ status: 'cancelled' });
    expect(() => service.requestAsk('session-a', { questions: [] })).toThrow();
    expect(appendChange).not.toHaveBeenCalled();
    const pending = service.requestAsk('session-a', args);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(service.list('session-a')).toHaveLength(1);
    await service.stop();
    await pending;
  });
});
