import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationEvent } from '@gateways/im';
import { DEFAULT_GATEWAY_CLOCK } from '@gateways/im/gateway-config';
import { credential, messageEvent } from '@gateways/im/__tests__/fixture';
import { FeishuMessageReactions, type FeishuReactionResponse } from './message-reactions';
import { FeishuSourceRegistry } from './source-registry';

const appId = 'app-1';
const owned = (id: string): FeishuReactionResponse => ({ code: 0,
  data: { reaction_id: id, operator: { operator_type: 'app', operator_id: appId } } });
const event = (revision: number, kind: NonNullable<NotificationEvent['persisted']>['kind'],
  extra: Partial<NonNullable<NotificationEvent['persisted']>> = {}, session = 'assistant-1'): NotificationEvent => ({
  instanceId: credential.instanceId, entityId: session, revision, kind: 'event.persisted',
  persisted: { kind, eventId: revision, ...extra },
});

function fixture() {
  const sources = new FeishuSourceRegistry();
  const api = { addReaction: vi.fn(async (_messageId: string, emoji: string) => owned(`reaction-${emoji}`)),
    deleteReaction: vi.fn(async () => ({ code: 0 })) };
  const report = vi.fn();
  let authorized = true;
  const progress = new FeishuMessageReactions(api, sources, DEFAULT_GATEWAY_CLOCK, appId, () => authorized, report);
  const begin = async (id = 'input-1') => sources.within({ eventId: id, messageId: `message-${id}`, chatId: 'chat-1',
    kind: 'message', occurredAt: Date.now() }, async () => { progress.begin(messageEvent(id, 'not retained'), credential); });
  return { sources, api, report, progress, begin, revoke: () => { authorized = false; } };
}
const flush = () => vi.advanceTimersByTimeAsync(1);

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('message reaction lifecycle', () => {
  it('waits for the correlated turn, keeps commentary processing, and switches through approval to completion', async () => {
    const f = fixture();
    await f.begin(); await flush();
    f.progress.accepted('input-1', { text: '', revision: 20, processing: { sessionId: 'assistant-1', correlationId: 'feishu:input-1' } });
    f.progress.notification(credential, 'chat-1', event(21, 'finished', { ok: true }));
    await flush();
    expect(f.api.addReaction.mock.calls.map(c => c[1])).toEqual(['Typing']);
    f.progress.notification(credential, 'chat-1', event(22, 'message', { role: 'user', correlationId: 'feishu:input-1' }));
    f.progress.notification(credential, 'chat-1', event(23, 'message', { role: 'assistant' }));
    await flush();
    expect(f.api.addReaction).toHaveBeenCalledTimes(1);
    f.progress.notification(credential, 'chat-1', event(24, 'waiting-for-user'), true);
    await flush();
    f.progress.resumed(credential, 'chat-1', 'assistant-1');
    await flush();
    f.progress.notification(credential, 'chat-1', event(25, 'finished', { ok: true }));
    await flush();
    expect(f.api.addReaction.mock.calls.map(c => c[1])).toEqual(['Typing', 'OneSecond', 'Typing', 'DONE']);
    expect(f.api.deleteReaction.mock.calls).toEqual([
      ['message-input-1', 'reaction-Typing'], ['message-input-1', 'reaction-OneSecond'], ['message-input-1', 'reaction-Typing'],
    ]);
    await f.progress.close();
    expect(f.api.deleteReaction).toHaveBeenCalledTimes(3);
  });

  it('does not let the previous turn, other credential or other chat finish the next queued input', async () => {
    const f = fixture();
    await f.begin(); await f.begin('input-2'); await flush();
    f.progress.notification(credential, 'chat-1', event(20, 'message', { role: 'user', correlationId: 'feishu:input-1' }));
    f.progress.notification(credential, 'chat-1', event(21, 'finished', { ok: true }));
    await flush();
    expect(f.api.addReaction).toHaveBeenCalledWith('message-input-1', 'DONE');
    expect(f.api.addReaction).not.toHaveBeenCalledWith('message-input-2', 'DONE');
    f.progress.notification({ ...credential, credentialId: 'other' }, 'chat-1', event(22, 'message', { role: 'user', correlationId: 'feishu:input-2' }));
    f.progress.notification(credential, 'other-chat', event(23, 'message', { role: 'user', correlationId: 'feishu:input-2' }));
    f.progress.notification(credential, 'chat-1', event(24, 'finished', { ok: true }));
    await flush();
    expect(f.api.addReaction).not.toHaveBeenCalledWith('message-input-2', 'DONE');
    f.progress.notification(credential, 'chat-1', event(25, 'message', { role: 'user', correlationId: 'feishu:input-2' }));
    f.progress.notification(credential, 'chat-1', event(26, 'finished', { ok: false }));
    await flush();
    expect(f.api.addReaction).toHaveBeenCalledWith('message-input-2', 'CrossMark');
    await f.progress.close();
  });

  it('serializes a fast completion behind an in-flight add and deduplicates input', async () => {
    const f = fixture();
    let resolve!: (value: FeishuReactionResponse) => void;
    f.api.addReaction.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await f.begin(); await f.begin();
    f.progress.accepted('input-1', { text: 'command complete', revision: 12 });
    expect(f.api.addReaction).toHaveBeenCalledTimes(1);
    resolve(owned('slow-processing')); await flush();
    expect(f.api.deleteReaction).toHaveBeenCalledWith('message-input-1', 'slow-processing');
    expect(f.api.addReaction.mock.calls.map(c => c[1])).toEqual(['Typing', 'DONE']);
    await f.progress.close();
  });

  it('tracks the first reply of a newly created work session and fences older revisions', async () => {
    const f = fixture(); await f.begin(); await flush();
    f.progress.accepted('input-1', { text: 'created', revision: 50, processing: { sessionId: 'work-new', afterRevision: 20 } });
    f.progress.notification(credential, 'chat-1', event(19, 'finished', { ok: true }, 'work-new'));
    f.progress.notification(credential, 'chat-1', event(22, 'finished', { ok: true }, 'different'));
    await flush(); expect(f.api.addReaction).toHaveBeenCalledTimes(1);
    f.progress.notification(credential, 'chat-1', event(30, 'finished', { ok: true }, 'work-new'));
    await flush(); expect(f.api.addReaction).toHaveBeenLastCalledWith('message-input-1', 'DONE');
    await f.progress.close();
  });

  it('bounds failed API attempts, removes an own late add and never deletes another operator reaction', async () => {
    const f = fixture();
    let resolve!: (value: FeishuReactionResponse) => void;
    f.api.addReaction.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await f.begin(); await vi.advanceTimersByTimeAsync(4_001);
    f.api.addReaction.mockResolvedValue({ code: 0, data: { reaction_id: 'someone-else', operator: { operator_type: 'user', operator_id: 'other' } } });
    resolve(owned('late-reaction')); await flush();
    expect(f.api.deleteReaction).toHaveBeenCalledWith('message-input-1', 'late-reaction');
    await vi.advanceTimersByTimeAsync(1_001);
    expect(f.api.deleteReaction).not.toHaveBeenCalledWith(expect.anything(), 'someone-else');
    expect(f.report).toHaveBeenCalledWith('reaction_rejected');
    await f.progress.close();
  });

  it('cleans in-flight indicators on shutdown and sends nothing for revoked or missing sources', async () => {
    const f = fixture();
    f.progress.begin(messageEvent('missing', 'ignored'), credential);
    expect(f.api.addReaction).not.toHaveBeenCalled();
    await f.begin(); await flush();
    await f.progress.close();
    expect(f.api.deleteReaction).toHaveBeenCalledWith('message-input-1', 'reaction-Typing');
    const revoked = fixture(); revoked.revoke(); await revoked.begin();
    expect(revoked.api.addReaction).not.toHaveBeenCalled(); await revoked.progress.close();
  });
});
