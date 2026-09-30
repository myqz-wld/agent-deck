import { describe, expect, it, vi } from 'vitest';
import { createPermissionPreviewDisplay } from '@contracts/index';
import type { FeishuOutboundMessage, FeishuPendingAction, FeishuPendingCard } from '@gateways/im';
import { credential, messageEvent, onlyClient, pending, select, setup } from '../im/__tests__/fixture';
import { createFeishuAuditBundle } from './audit';
import { FEISHU_ACTION_PROTOCOL } from './action-envelope';
import { renderFeishuCard } from './card-renderer';
import { FeishuSdkEventAdapter } from './event-adapter';
import { HmacPendingActionNonce } from './nonce';
import { pendingCardContent } from './pending-card-content';
import { FeishuSourceRegistry } from './source-registry';
import { OfficialFeishuTransport } from './transport';

const NOW = 1_710_000_000_000;
const clock = { now: () => NOW, setTimer: () => ({ cancel: () => undefined }) };

function nativePreview() {
  return createPermissionPreviewDisplay('Codex CLI MCP 工具调用', {
    serverName: 'agent-deck', message: 'Allow the agent-deck MCP server to run tool "task_create"?',
    _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'],
      tool_description: 'Create a personal task.',
      tool_params: { subject: '审批测试', description: '只验证审批，不操作文件', apiKey: 'synthetic-secret' },
      tool_params_display: [{ name: 'subject', value: 'DUPLICATE DISPLAY' }] },
  });
}

function rawCard(action: FeishuPendingAction, eventId: string): Record<string, unknown> {
  return { schema: '2.0', event_id: eventId, event_type: 'card.action.trigger', create_time: String(NOW * 1000),
    app_id: credential.appId, tenant_key: credential.tenantKey, token: 'synthetic-callback',
    operator: { open_id: credential.openId, tenant_key: credential.tenantKey }, host: 'im_message',
    context: { open_chat_id: action.chatId, open_message_id: 'card-message' },
    action: { tag: 'button', value: { protocol: FEISHU_ACTION_PROTOCOL, action, expiresAt: NOW + 30 * 60_000 } } };
}

describe('native approval presentation and callback completion', () => {
  it('returns the terminal card with the SDK response, never PATCHes before acknowledgement, and repairs repeated clicks', async () => {
    const sources = new FeishuSourceRegistry();
    const nonce = new HmacPendingActionNonce(Buffer.alloc(32, 9), { now: clock.now });
    const api = { reply: vi.fn(), create: vi.fn(), patchCard: vi.fn() };
    const official = new OfficialFeishuTransport({ instanceId: credential.instanceId }, api, sources, nonce);
    const messages: FeishuOutboundMessage[] = [];
    const t = setup({ nonce, clock, transport: { deliverySemantics: 'event-id-idempotent',
      deliver: async (message, attempt) => { messages.push(message); if (message.kind === 'card-update') await official.deliver(message, attempt); } } });
    await select(t.gateway);
    const client = onlyClient(t.clients);
    client.pending.set('session-1', [{ ...pending(), display: nativePreview() }]);
    await t.gateway.handle(messageEvent('show-card', '/pending'));
    const shown = messages.at(-1)!;
    const readable = pendingCardContent(shown.cards[0]);
    expect(readable.content).toContain('创建待办');
    expect(readable.content).toContain('**标题**\n审批测试');
    expect(readable.content).toContain('只验证审批，不操作文件');
    expect(readable.content).not.toMatch(/synthetic-secret|DUPLICATE DISPLAY|codex_approval_kind|requestId|sessionId/);
    const rendered = JSON.parse(renderFeishuCard(shown, nonce));
    expect(rendered.body.elements.find((e: { tag: string }) => e.tag === 'column_set').columns)
      .toHaveLength(2);
    const action = shown.cards[0].buttons[0].action;
    // Usage or another session advances the global revision while this approval is unchanged.
    client.revision += 7;
    const currentRevision = client.revision;
    const audit = createFeishuAuditBundle({ appId: credential.appId, tenantKey: credential.tenantKey,
      instanceId: credential.instanceId, topology: 'full' }, clock, () => undefined);
    const adapter = new FeishuSdkEventAdapter(t.gateway, { appId: credential.appId,
      tenantKey: credential.tenantKey, now: clock.now }, sources, audit);
    const result = await adapter.onCardAction(rawCard(action, 'approve-once'));
    expect(result).toMatchObject({ toast: { type: 'success' }, card: { type: 'raw',
      data: { schema: '2.0', header: { title: { content: expect.stringContaining('已批准') } },
        body: { elements: [{ tag: 'markdown', content: '已确认，助手将继续处理。' }] } } } });
    expect(api.patchCard).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
    expect(sources.size()).toBe(0);
    expect(sources.getCallbackCard('approve-once')).toBeUndefined();
    expect(client.calls.filter(c => c.method === 'pending.respond')).toHaveLength(1);
    expect(client.calls.find(c => c.method === 'pending.respond')?.options?.expectedRevision).toBe(currentRevision);
    expect(await adapter.onCardAction(rawCard(action, 'stale-second-click'))).toMatchObject({
      card: { data: { header: { title: { content: expect.stringContaining('审批已结束') } },
        body: { elements: [{ tag: 'markdown', content: '该请求已处理，无需再次操作。' }] } } },
    });
    expect(client.calls.filter(c => c.method === 'pending.respond')).toHaveLength(1);
    expect(t.store.exportMetadataSnapshot()).not.toContain('审批测试');
    await t.gateway.close();
  });

  it('uses Chinese management labels, hides only known tracking fields and keeps unknown parameters', () => {
    const params = { expectedSettingsRevision: 3, requestId: 'request-synthetic', title: '连接验证',
      initialMessage: '只回复连接正常', selection: { adapterId: 'codex-cli', model: 'model-test',
        approvalPolicy: 'on-request', codexSandbox: 'workspace-write' } };
    const display = (serverName: string) => createPermissionPreviewDisplay('Codex CLI MCP 工具调用', {
      serverName, message: `Allow the ${serverName} MCP server to run tool "create_work_session"?`,
      _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: params },
    });
    const card: FeishuPendingCard = { title: '助手 · 操作审批', requestId: 'pending-1', sessionId: 'session-1',
      state: 'pending', createdAt: NOW, presentedAt: NOW, expiresAt: null, presentationLifetimeMs: 0,
      buttons: [], display: { requestKind: 'permission', details: display('agent-deck') } };
    const result = pendingCardContent(card);
    expect(result.canApprove).toBe(true);
    expect(result.content).toContain('**创建工作会话**');
    expect(result.content).toContain('**会话名称**\n连接验证');
    expect(result.content).toContain('**首条任务**\n只回复连接正常');
    expect(result.content).toContain('按需审批');
    expect(result.content).not.toMatch(/expectedSettingsRevision|requestId|create_work_session|approvalPolicy/);
    const unknown = pendingCardContent({ ...card, display: { requestKind: 'permission', details: display('another-server') } });
    expect(unknown.content).toContain('expectedSettingsRevision');
    expect(unknown.content).toContain('request-synthetic');
  });

  it('keeps unknown tool parameters visible and disables approval for incomplete or clipped previews', () => {
    const card: FeishuPendingCard = { title: '助手 · 操作审批', requestId: 'request-1', sessionId: 'session-1',
      state: 'pending', createdAt: NOW, presentedAt: NOW, expiresAt: null, presentationLifetimeMs: 0,
      buttons: [], display: { requestKind: 'permission', details: { tool: 'Custom',
        input: { argument: 'keep-this', command: '<at id=all> **spoof**' }, complete: true, redacted: false } } };
    expect(pendingCardContent(card)).toMatchObject({ canApprove: true, content: expect.stringContaining('keep-this') });
    expect(pendingCardContent(card).content).not.toContain('<at');
    expect(pendingCardContent({ ...card, display: { requestKind: 'permission', details: {
      tool: 'Large', input: { command: 'x'.repeat(14_000) }, complete: true, redacted: false,
    } } })).toMatchObject({ canApprove: false, content: expect.stringContaining('详情未完整显示') });
    expect(pendingCardContent({ ...card, display: { requestKind: 'permission', details: {
      tool: 'Incomplete', input: { command: 'short' }, complete: false, redacted: false,
    } } }).canApprove).toBe(false);
  });
});
