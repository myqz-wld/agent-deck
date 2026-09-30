import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createServerCoreMcpServer } from './mcp-server';
import { withClient, structuredPayload } from './mcp-server-test-client';
import { cleanupMcpServerHarnesses, createMcpServerHarness } from './mcp-server.test-fixture';
import { FeishuWorkSessionDirectory } from './feishu-work-session-directory';

afterEach(cleanupMcpServerHarnesses);
describe('work-session MCP read contract', () => {
  it.each(['claude-code', 'codex-cli', 'grok-build'] as const)(
    'publishes a native-safe read and independent work directory for %s', async adapter => {
      const { host, records, changes } = createMcpServerHarness();
      records.set('caller-a', { ...records.get('caller-a')!, agentId: adapter, codexApprovalPolicy: 'never' });
      records.set('caller-b', { ...records.get('caller-b')!, lifecycle: 'dormant' });
      const directory = new FeishuWorkSessionDirectory({ assistants: { read: () => ['caller-a'] },
        sessions: { get: id => records.get(id) ?? null,
          listActiveAndDormant: (limit, offset) => [...records.values()].slice(offset, offset + limit) },
        successor: () => null, project: (caller, id) => host.collaboration.get(caller, id) });
      const server = await createServerCoreMcpServer({ ...host, feishuWorkSessions: directory },
        () => 'caller-a', adapter, { McpServer });
      await withClient(server, async client => {
        const tool = (await client.listTools()).tools.find(item => item.name === 'list_work_sessions');
        expect(tool?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false,
          idempotentHint: true, openWorldHint: false });
        const result = structuredPayload(await client.callTool({ name: 'list_work_sessions', arguments: {} }));
        expect(result).toMatchObject({ assistantSessionId: 'caller-a', sessions: [{ sessionId: 'caller-b', lifecycle: 'dormant' }],
          hasMore: false, nextOffset: null });
        const generic = structuredPayload(await client.callTool({ name: 'list_sessions', arguments: {} }));
        expect(generic).toMatchObject({ sessions: [{ sessionId: 'caller-a' }] });
        expect(changes).toEqual([]);
        expect(records.get('caller-a')?.codexApprovalPolicy).toBe('never');
      });
    },
  );

  it('rejects missing callers and sanitizes unavailable registration without a generic-list fallback', async () => {
    const { host, changes } = createMcpServerHarness();
    for (const caller of ['missing', 'caller-a']) {
      const server = await createServerCoreMcpServer({ ...host, feishuWorkSessions: {
        list: () => { throw new Error('synthetic private storage detail'); },
      } }, () => caller, 'codex-cli', { McpServer });
      await withClient(server, async client => {
        const result = await client.callTool({ name: 'list_work_sessions', arguments: {} });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain('synthetic private');
        expect(JSON.stringify(result)).toContain('/sessions');
      });
    }
    expect(changes).toEqual([]);
  });
});
