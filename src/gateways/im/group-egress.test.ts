import { describe, expect, it } from 'vitest';
import {
  actionFrom,
  flush,
  messageEvent,
  onlyClient,
  pending,
  project,
  session,
  setup,
} from './__tests__/fixture';

describe('group-chat Core egress policy', () => {
  it('suppresses session and project listings before calling Core', async () => {
    const { gateway, clients, transport } = setup();
    await gateway.handle(messageEvent('group-list-prime', '/help', { chatType: 'group' }));
    const client = onlyClient(clients);
    client.sessions.set('sensitive-session', {
      ...session('sensitive-session'),
      title: 'DATABASE_URL=postgres://admin:secret@db.internal/prod',
    });
    client.projects.set('sensitive-project', {
      ...project('sensitive-alias', 'sensitive-project', 'opaque-sensitive-ref'),
      title: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    });
    const sessionCalls = client.calls.filter(
      (call) => call.method === 'session.console.list',
    ).length;
    const projectCalls = client.calls.filter((call) => call.method === 'project.list').length;
    transport.messages.length = 0;

    await gateway.handle(messageEvent('group-sessions', '/sessions', { chatType: 'group' }));
    await gateway.handle(messageEvent('group-projects', '/projects', { chatType: 'group' }));

    expect(client.calls.filter((call) => call.method === 'session.console.list'))
      .toHaveLength(sessionCalls);
    expect(client.calls.filter((call) => call.method === 'project.list'))
      .toHaveLength(projectCalls);
    expect(transport.messages.map((message) => message.text)).toEqual([
      '群聊中已隐藏 session 列表。请使用完整客户端查看。',
      '群聊中已隐藏 project 列表。请使用完整客户端查看。',
    ]);
    expect(JSON.stringify(transport.messages)).not.toMatch(
      /postgres|secret|AKIAIOSFODNN7EXAMPLE|sensitive-alias|opaque-sensitive-ref/,
    );
  });

  it('suppresses history and runtime before calling Core', async () => {
    const { gateway, clients, transport } = setup();
    await gateway.handle(messageEvent('group-select', '/select session-1', { chatType: 'group' }));
    const client = onlyClient(clients);
    client.histories.set('session-1', [{
      id: 'history-1',
      sessionId: 'session-1',
      sequence: 1,
      role: 'assistant',
      content: 'DATABASE_URL=postgres://admin:secret@db.internal/prod',
      createdAt: 1,
    }]);
    client.runtime.set('session-1', {
      adapterId: 'codex-cli',
      values: { connectionString: 'Server=db;Password=secret' },
      revision: 10,
    });
    const historyCalls = client.calls.filter((call) => call.method === 'session.history').length;
    const runtimeCalls = client.calls.filter((call) => call.method === 'session.runtime.get').length;
    transport.messages.length = 0;

    await gateway.handle(messageEvent('group-history', '/history', { chatType: 'group' }));
    await gateway.handle(messageEvent('group-runtime', '/runtime', { chatType: 'group' }));

    expect(client.calls.filter((call) => call.method === 'session.history')).toHaveLength(historyCalls);
    expect(client.calls.filter((call) => call.method === 'session.runtime.get')).toHaveLength(runtimeCalls);
    expect(JSON.stringify(transport.messages)).not.toMatch(/postgres|Password=secret/);
    expect(transport.messages.map((message) => message.text)).toEqual([
      '群聊中已隐藏 history 内容。请使用完整客户端查看。',
      '群聊中已隐藏 runtime 值。请使用完整客户端查看。',
    ]);
  });

  it('emits only an owned read-only pending projection for group commands and notifications', async () => {
    const { gateway, clients, transport } = setup();
    await gateway.handle(messageEvent('group-pending-select', '/select session-1', {
      chatType: 'group',
    }));
    const client = onlyClient(clients);
    client.pending.set('session-1', [{
      ...pending(),
      display: {
        command: 'kubectl --token=abcdefghijklmnopqrstuvwxyz123456789012 get pods',
        connectionString: 'postgres://admin:secret@db.internal/prod',
      },
    }]);
    transport.messages.length = 0;
    await gateway.handle(messageEvent('group-pending', '/pending', { chatType: 'group' }));
    const commandCard = transport.messages.at(-1)?.cards[0];
    expect(commandCard?.buttons).toEqual([]);
    expect(commandCard?.display).toEqual({
      requestKind: 'permission',
      notice: '群聊中已隐藏敏感的 pending 详情。请使用完整客户端查看。',
    });
    expect(JSON.stringify(commandCard)).not.toMatch(/kubectl|postgres|secret/);

    await gateway.handle(messageEvent('group-subscribe', '/subscribe', { chatType: 'group' }));
    transport.messages.length = 0;
    client.emit({
      instanceId: 'instance-1',
      revision: 11,
      kind: 'pending.created',
      entityId: 'pending-1',
      payload: { ignored: 'provider-secret' },
    });
    await flush();
    await flush();
    const notification = transport.messages.find((message) => message.kind === 'notification');
    expect(notification?.cards[0]?.buttons).toEqual([]);
    expect(JSON.stringify(notification)).not.toMatch(/kubectl|postgres|provider-secret/);
  });

  it('retains actionable allowlisted projections for owner p2p chats', async () => {
    const { gateway, clients, transport } = setup();
    await gateway.handle(messageEvent('p2p-select', '/select session-1'));
    onlyClient(clients).pending.set('session-1', [{
      ...pending(),
      display: { tool: 'Bash', command: 'pnpm test', connectionString: 'secret' },
    }]);
    transport.messages.length = 0;
    await gateway.handle(messageEvent('p2p-pending', '/pending'));
    const card = transport.messages.at(-1)?.cards[0];
    expect(card?.display).toMatchObject({
      requestKind: 'permission',
      details: { tool: 'Bash', command: 'pnpm test' },
    });
    expect(card?.display).not.toHaveProperty('details.connectionString');
    expect(actionFrom(transport.messages.at(-1)!).action).toBe('approve');
  });
});
