import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultFeishuModelPreference } from '@contracts/index';
import { createServerCoreMcpServer } from './mcp-server';
import { structuredPayload, withClient } from './mcp-server-test-client';
import { cleanupMcpServerHarnesses, createMcpServerHarness } from './mcp-server.test-fixture';

afterEach(cleanupMcpServerHarnesses);
describe('live Feishu preferences in conversational MCP', () => {
  it('returns changed choices on each read and exposes no write operation', async () => {
    const { host } = createMcpServerHarness();
    let model = 'first-model';
    const server = await createServerCoreMcpServer({ ...host, feishuPreferences: { read: () => ({
      conversation: { ...defaultFeishuModelPreference(), adapterId: 'claude-code', permissionMode: 'plan', claudeCodeSandbox: 'strict' },
      session: { ...defaultFeishuModelPreference(), adapterId: 'codex-cli', model, approvalPolicy: 'on-request', codexSandbox: 'read-only' }, settingsRevision: 1,
    }) } }, () => 'caller-a', 'codex-cli', { McpServer });
    await withClient(server, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.filter(tool => tool.name.includes('feishu')).map(tool => tool.name)).toEqual(['get_feishu_preferences']);
      expect(structuredPayload(await client.callTool({ name: 'get_feishu_preferences', arguments: {} })))
        .toMatchObject({ session: { model: 'first-model', approvalPolicy: 'on-request', codexSandbox: 'read-only' },
          conversation: { adapterId: 'claude-code', permissionMode: 'plan', claudeCodeSandbox: 'strict' } });
      model = 'second-model';
      expect(structuredPayload(await client.callTool({ name: 'get_feishu_preferences', arguments: {} })))
        .toMatchObject({ session: { model: 'second-model' } });
    });
  });
  it('rejects an unavailable caller without exposing the private store error', async () => {
    const { host } = createMcpServerHarness();
    const server = await createServerCoreMcpServer({ ...host, feishuPreferences: { read: () => { throw new Error('private path'); } } },
      () => 'missing-caller', 'codex-cli', { McpServer });
    await withClient(server, async (client) => {
      const result = await client.callTool({ name: 'get_feishu_preferences', arguments: {} });
      expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain('private path');
    });
  });
});
