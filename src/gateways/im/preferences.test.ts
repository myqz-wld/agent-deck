import { describe, expect, it } from 'vitest';
import { defaultFeishuModelPreference } from '@contracts/index';
import { parseFeishuCommand } from './commands';
import { messageEvent, onlyClient, setup } from './__tests__/fixture';

describe('Feishu last model selections', () => {
  it('asks for a first choice instead of silently starting Claude or another available adapter', async () => {
    const t = setup(); await t.gateway.handle(messageEvent('prime', '/help'));
    const client = onlyClient(t.clients);
    client.preferences.conversation = defaultFeishuModelPreference();
    expect((await t.gateway.handle(messageEvent('first', '你好'))).code).toBe('model_selection_required');
    expect(client.calls.some(call => call.method === 'session.console.create')).toBe(false);
    expect(t.transport.messages.at(-1)?.text).toContain('/settings chat');
    await t.gateway.close();
  });
  it('saves separate chat/work choices and reuses them across new conversations and explicit overrides', async () => {
    const t = setup();
    await t.gateway.handle(messageEvent('choose-chat', '/settings chat claude-code {"model":"chat-model","thinking":"max"}'));
    await t.gateway.handle(messageEvent('choose-work', '/settings session codex-cli {"model":"work-model","thinking":"high"}'));
    await t.gateway.handle(messageEvent('chat', '你好'));
    const client = onlyClient(t.clients);
    expect(client.calls.filter(call => call.method === 'session.console.create').at(-1)?.params).toMatchObject({
      adapterId: 'claude-code', options: { model: 'chat-model', thinking: 'max' },
    });
    await t.gateway.handle(messageEvent('work', '/create last . -- 检查项目'));
    expect(client.calls.filter(call => call.method === 'session.console.create').at(-1)?.params).toMatchObject({
      adapterId: 'codex-cli', options: { model: 'work-model', thinking: 'high' },
    });
    await t.gateway.handle(messageEvent('override', '/create last . --model next-model --thinking max -- 检查文档'));
    expect(client.preferences.session).toMatchObject({ adapterId: 'codex-cli', model: 'next-model', thinking: 'max' });
    await t.gateway.handle(messageEvent('new-chat', '/new'));
    expect(client.calls.filter(call => call.method === 'session.console.create').at(-1)?.params).toMatchObject({
      adapterId: 'claude-code', options: { model: 'chat-model' },
    });
    expect(client.sessions.size).toBeGreaterThanOrEqual(4);
    await t.gateway.close();
  });
  it('does not expose private configuration or change it through group commands', async () => {
    const t = setup();
    for (const [index, command] of ['/settings', '/models', '/settings chat claude-code'].entries()) {
      await t.gateway.handle(messageEvent(`group-${index}`, command, { chatType: 'group' }));
    }
    expect([...t.clients.values()].flatMap(client => client.calls).some(call => call.method.startsWith('feishu.preferences'))).toBe(false);
    expect(t.transport.messages.at(-1)?.text).toContain('私聊');
    await t.gateway.close();
  });
  it('refuses incompatible saved thinking without changing the saved model or creating a substitute', async () => {
    const t = setup(); await t.gateway.handle(messageEvent('prime', '/help'));
    const client = onlyClient(t.clients); client.preferences.conversation.thinking = 'removed-choice';
    expect((await t.gateway.handle(messageEvent('unavailable', '你好'))).code).toBe('saved_model_unavailable');
    expect(client.preferences.conversation.thinking).toBe('removed-choice');
    expect(client.calls.some(call => call.method === 'session.console.create')).toBe(false);
    await t.gateway.close();
  });
  it('keeps free text and directory spaces intact while strictly bounding choice options', () => {
    expect(parseFeishuCommand('/create last project directory --model selected-model -- 原始 -- 内容')).toEqual({
      kind: 'create', adapterId: null, workingDirectory: 'project directory', selection: { model: 'selected-model' }, initialMessage: '原始 -- 内容',
    });
    for (const text of ['/settings chat codex-cli {"secret":"x"}', '/settings chat grok-build {"provider":"wrong"}',
      '/settings chat codex-cli {"model":"' + 'a'.repeat(513) + '"}', '/create last . --model first --model second -- hello']) {
      expect(() => parseFeishuCommand(text)).toThrow();
    }
  });
});
