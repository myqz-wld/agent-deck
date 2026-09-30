import { afterEach, describe, expect, it } from 'vitest';
import { createServerCoreMcpServer } from './mcp-server';
import { cleanupMcpServerHarnesses, createMcpServerHarness } from './mcp-server.test-fixture';
import { structuredPayload, withClient } from './mcp-server-test-client';
import { cleanupFeishuWorkHarnesses, createFeishuWorkHarness } from './feishu-work-management.fixture';

afterEach(() => { cleanupMcpServerHarnesses(); cleanupFeishuWorkHarnesses(); });
describe('Feishu native management tool contracts', () => {
  it.each(['codex-cli', 'claude-code', 'grok-build'] as const)('exposes real named mutations with native approval for %s', async adapter => {
    const t = createFeishuWorkHarness();
    const mcp = createMcpServerHarness();
    mcp.records.set('assistant-a', { ...mcp.records.get('caller-a')!, id: 'assistant-a', agentId: adapter });
    const server = await createServerCoreMcpServer({ ...mcp.host,
      feishuPreferences: t.store, feishuManagement: t.service,
      feishuWorkSessions: { list: () => ({ scope: 'open-work-sessions', assistantSessionId: 'assistant-a',
        sessions: [], hasMore: false, nextOffset: null }) },
    }, () => 'assistant-a', adapter);
    await withClient(server, async client => {
      const tools = (await client.listTools()).tools;
      for (const name of ['create_work_session', 'rename_work_session', 'update_feishu_preferences']) {
        expect(tools.find(t => t.name === name)?.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: true });
      }
      expect(structuredPayload(await client.callTool({ name: 'get_feishu_preferences', arguments: {} })))
        .toMatchObject({ settingsRevision: 2, session: { model: 'work-model' } });
      const created = structuredPayload(await client.callTool({ name: 'create_work_session', arguments: t.args }));
      expect(created).toMatchObject({ sessionId: 'created-work', title: '连接验证', preference: { model: 'work-model' } });
      expect(structuredPayload(await client.callTool({ name: 'rename_work_session', arguments: {
        requestId: 'native-rename', sessionId: 'created-work', title: '验证完成', expectedTitle: '连接验证',
      } }))).toMatchObject({ sessionId: 'created-work', title: '验证完成' });
      expect(structuredPayload(await client.callTool({ name: 'update_feishu_preferences', arguments: {
        requestId: 'native-choice', purpose: 'conversation', preference: { thinking: 'high' }, expectedSettingsRevision: 2,
      } }))).toMatchObject({ settingsRevision: 3, conversation: { model: 'chat-model', thinking: 'high', approvalPolicy: 'on-request' },
        session: { model: 'work-model', thinking: 'medium' } });
      expect(t.createSpawnSession).toHaveBeenCalledTimes(1);
    });
  });

  it('rejects unregistered native callers and invalid inputs before any provider creation', async () => {
    const t = createFeishuWorkHarness(); const mcp = createMcpServerHarness();
    const server = await createServerCoreMcpServer({ ...mcp.host, feishuPreferences: t.store, feishuManagement: t.service,
      feishuWorkSessions: { list: () => ({ scope: 'open-work-sessions', assistantSessionId: 'caller-a',
        sessions: [], hasMore: false, nextOffset: null }) },
    }, () => 'caller-a', 'codex-cli');
    await withClient(server, async client => {
      expect((await client.callTool({ name: 'create_work_session', arguments: t.args })).isError).toBe(true);
      expect((await client.callTool({ name: 'create_work_session', arguments: { ...t.args, requestId: null } })).isError).toBe(true);
      expect((await client.callTool({ name: 'update_feishu_preferences', arguments: {
        requestId: 'unknown-choice', purpose: 'session', preference: { unknownField: 'x' }, expectedSettingsRevision: 2,
      } })).isError).toBe(true);
      expect(t.createSpawnSession).not.toHaveBeenCalled();
      expect(t.store.write).not.toHaveBeenCalled();
    });
  });
});
