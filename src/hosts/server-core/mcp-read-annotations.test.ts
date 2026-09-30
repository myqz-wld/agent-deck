import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultFeishuModelPreference } from '@contracts/index';
import { createServerCoreMcpServer } from './mcp-server';
import { withClient } from './mcp-server-test-client';
import { cleanupMcpServerHarnesses, createMcpServerHarness } from './mcp-server.test-fixture';

const READ_TOOLS = [
  'get_feishu_preferences', 'get_session', 'list_session_events', 'list_sessions',
  'task_get', 'task_list',
];

afterEach(cleanupMcpServerHarnesses);

describe('Server Core read-only MCP discovery', () => {
  it.each(['claude-code', 'codex-cli', 'grok-build'] as const)(
    'publishes safe read metadata without marking mutations read-only for %s', async (adapter) => {
      const { host, records } = createMcpServerHarness();
      records.set('caller-a', { ...records.get('caller-a')!, agentId: adapter });
      const server = await createServerCoreMcpServer({ ...host, feishuPreferences: {
        read: () => ({ conversation: defaultFeishuModelPreference(),
          session: defaultFeishuModelPreference(), settingsRevision: 0 }),
      } }, () => 'caller-a', adapter, { McpServer });
      await withClient(server, async (client) => {
        const { tools } = await client.listTools();
        const managementTools = tools.filter(tool => !tool.name.startsWith('browser_'));
        expect(managementTools.filter(tool => tool.annotations?.readOnlyHint)
          .map(tool => tool.name).sort()).toEqual(READ_TOOLS);
        for (const name of READ_TOOLS) {
          expect(tools.find(tool => tool.name === name)?.annotations, name).toEqual({
            readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
          });
        }
      });
    },
  );

  it('still rejects an unavailable caller for every advertised read', async () => {
    const { host, changes } = createMcpServerHarness();
    const server = await createServerCoreMcpServer({ ...host, feishuPreferences: {
      read: () => ({ conversation: defaultFeishuModelPreference(),
        session: defaultFeishuModelPreference(), settingsRevision: 0 }),
    } }, () => 'missing-caller', 'codex-cli', { McpServer });
    await withClient(server, async (client) => {
      for (const name of READ_TOOLS) {
        const args = name === 'task_get' ? { taskId: 'missing-task' }
          : ['get_session', 'list_session_events'].includes(name) ? { sessionId: 'caller-b' } : {};
        expect((await client.callTool({ name, arguments: args })).isError, name).toBe(true);
      }
      expect(changes).toEqual([]);
    });
  });
});
