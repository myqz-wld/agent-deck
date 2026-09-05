import { afterEach, describe, expect, it, vi } from 'vitest';
import { WSClient, type Client } from '@larksuiteoapi/node-sdk';
import { createOfficialFeishuConnectionFactory, OfficialFeishuOpenApi } from './sdk';

const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const callbacks = { onReady() {}, onError() {}, onReconnecting() {}, onReconnected() {} };
const handlers = { onMessage: vi.fn(), onCardAction: vi.fn() };

afterEach(() => vi.restoreAllMocks());

describe('authenticated Feishu bot identity startup', () => {
  it('resolves the stable open id using the authenticated SDK client', async () => {
    const request = vi.fn(async () => ({ code: 0, bot: { open_id: 'ou_bot', app_name: 'Renamable label' } }));
    const api = new OfficialFeishuOpenApi({ request } as unknown as Client);
    await expect(api.botOpenId()).resolves.toBe('ou_bot');
    expect(request).toHaveBeenCalledWith({ url: '/open-apis/bot/v3/info', method: 'GET', timeout: 15_000 });
  });

  it.each([
    { code: 1, bot: { open_id: 'ou_bot' } },
    { code: 0 },
    { code: 0, bot: { open_id: 'ou_bot\ninvalid' } },
    { code: 0, bot: { open_id: 'x'.repeat(257) } },
  ])('rejects unusable or failed identity responses without provider detail: %j', async (response) => {
    const api = new OfficialFeishuOpenApi({ request: async () => response } as unknown as Client);
    await expect(api.botOpenId()).rejects.toMatchObject({ code: 'lifecycle_failed', message: '无法获取飞书机器人身份' });
  });

  it('does not log or propagate a credential-bearing SDK error', async () => {
    const api = new OfficialFeishuOpenApi({ request: async () => { throw new Error('sensitive-sdk-detail'); } } as unknown as Client);
    const error = await api.botOpenId().catch((error: unknown) => error);
    expect(String(error)).not.toContain('sensitive-sdk-detail');
    expect(error).toMatchObject({ code: 'lifecycle_failed' });
  });

  it('waits for identity before enabling SDK events', async () => {
    const start = vi.spyOn(WSClient.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(WSClient.prototype, 'close').mockImplementation(() => undefined);
    let ready!: () => void;
    const prepared = new Promise<void>((resolve) => { ready = resolve; });
    const connection = createOfficialFeishuConnectionFactory('app_fixture', 'secret_fixture', logger, 100, 45, () => prepared)(callbacks);
    const starting = connection.start(handlers);
    expect(start).not.toHaveBeenCalled();
    ready();
    await starting;
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][0].eventDispatcher).toBeDefined();
    connection.close(true);
  });

  it('never opens a late SDK connection after close during identity lookup', async () => {
    const start = vi.spyOn(WSClient.prototype, 'start').mockResolvedValue(undefined);
    const close = vi.spyOn(WSClient.prototype, 'close').mockImplementation(() => undefined);
    let ready!: () => void;
    const prepared = new Promise<void>((resolve) => { ready = resolve; });
    const connection = createOfficialFeishuConnectionFactory('app_fixture', 'secret_fixture', logger, 100, 45, () => prepared)(callbacks);
    const starting = connection.start(handlers);
    connection.close(true);
    ready();
    await starting;
    expect(start).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith({ force: true });
  });

  it('keeps event startup closed when identity lookup fails', async () => {
    const start = vi.spyOn(WSClient.prototype, 'start').mockResolvedValue(undefined);
    vi.spyOn(WSClient.prototype, 'close').mockImplementation(() => undefined);
    const connection = createOfficialFeishuConnectionFactory('app_fixture', 'secret_fixture', logger, 100, 45,
      async () => { throw new Error('identity-unavailable'); })(callbacks);
    await expect(connection.start(handlers)).rejects.toThrow('identity-unavailable');
    expect(start).not.toHaveBeenCalled();
    connection.close(true);
  });
});
