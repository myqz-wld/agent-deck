import { describe, expect, it } from 'vitest';
import type { AgentDeckSubscription } from '@contracts/index';
import type { FeishuAgentDeckClientFactory } from './types';
import { FakeCoreClient, credential, flush, messageEvent, project, setup } from './__tests__/fixture';

class TerminalClient extends FakeCoreClient {
  readonly terminalListeners = new Set<() => void>();
  readonly terminalHistory: Array<() => void> = [];
  offline = false;

  constructor(input: Parameters<FeishuAgentDeckClientFactory>[0]) {
    super(input);
    this.projects.set('project-1', project());
    this.requestHook = () => {
      if (this.offline) throw Object.assign(new Error('No active SSH connection'), {
        code: 'not_connected',
      });
    };
  }

  onTerminal(listener: () => void): AgentDeckSubscription {
    this.terminalListeners.add(listener);
    this.terminalHistory.push(listener);
    if (this.offline) listener();
    return { close: () => { this.terminalListeners.delete(listener); } };
  }

  terminate(): void {
    this.offline = true;
    for (const listener of this.terminalListeners) listener();
  }
}

describe('Feishu terminal Core transport recovery', () => {
  it('reconnects the next command after an idle client becomes terminal and fences stale observers', async () => {
    const clients: TerminalClient[] = [];
    const { gateway, store, transport } = setup({ clientFactory: (input) => {
      const client = new TerminalClient(input);
      clients.push(client);
      return client;
    } });
    await gateway.handle(messageEvent('before-disconnect', '/help'));
    const old = clients.at(-1)!;
    old.terminate();
    await flush();
    await expect(gateway.handle(messageEvent('after-disconnect', '/directories')))
      .resolves.toMatchObject({ code: 'accepted' });
    expect(transport.messages.at(-1)?.text).toContain('Workspace 根目录');
    expect(old.closed).toBe(true);
    expect(old.terminalListeners.size).toBe(0);
    const current = clients.at(-1)!;
    expect(current).not.toBe(old);
    for (const listener of old.terminalHistory) listener();
    await flush();
    expect(current.closed).toBe(false);
    expect(store.getCursor(credential.instanceId, credential.credentialId, 'chat-1')?.revision).toBe(10);
    await gateway.close();
    expect(current.terminalListeners.size).toBe(0);
  });

  it('awaits the old close barrier before admitting a replacement transport', async () => {
    const clients: TerminalClient[] = [];
    let release!: () => void;
    const closeHold = new Promise<void>((resolve) => { release = resolve; });
    const { gateway } = setup({ clientFactory: (input) => {
      const client = new TerminalClient(input);
      clients.push(client);
      return client;
    } });
    await gateway.handle(messageEvent('held-before', '/help'));
    const old = clients.at(-1)!;
    old.closeHold = closeHold;
    old.terminate();
    const count = clients.length;
    const handling = gateway.handle(messageEvent('held-after', '/directories'));
    await flush();
    expect(clients).toHaveLength(count);
    release();
    await expect(handling).resolves.toMatchObject({ code: 'accepted' });
    expect(clients).toHaveLength(count + 1);
    await gateway.close();
  });

  it('cleans up a transport that terminates while its observer is being attached', async () => {
    const clients: TerminalClient[] = [];
    const { gateway, store } = setup({ clientFactory: (input) => {
      const client = new TerminalClient(input);
      client.offline = clients.length === 0;
      clients.push(client);
      return client;
    } });
    store.putCursor({
      instanceId: credential.instanceId, credentialId: credential.credentialId,
      chatId: 'chat-1', revision: 10, updatedAt: 0,
    });
    await expect(gateway.handle(messageEvent('terminal-during-admission', '/directories')))
      .rejects.toMatchObject({ code: 'gateway_closed' });
    expect(clients[0].closed).toBe(true);
    expect(clients[0].terminalListeners.size).toBe(0);
    await expect(gateway.handle(messageEvent('fresh-admission', '/directories')))
      .resolves.toMatchObject({ code: 'accepted' });
    expect(clients).toHaveLength(2);
    await gateway.close();
  });
});
