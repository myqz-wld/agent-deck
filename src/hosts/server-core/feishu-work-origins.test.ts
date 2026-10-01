import { afterEach, describe, expect, it } from 'vitest';
import { cleanupFeishuWorkHarnesses, createFeishuWorkHarness } from './feishu-work-management.fixture';

afterEach(cleanupFeishuWorkHarnesses);
describe('durable work creation provenance', () => {
  it('survives canonical rename and ordinary mutation expiry without retaining unrelated mutations', async () => {
    const t = createFeishuWorkHarness();
    const created = await t.service.create('assistant-a', t.args);
    const origin = { connectionScope: 'feishu-assistant:previous-assistant', accessSurface: 'feishu' as const,
      method: 'feishu.work.create', idempotencyKey: 'earlier-create', requestFingerprint: 'b'.repeat(64) };
    t.metadata.claimMutation(origin, 1);
    t.metadata.commitFeishuWorkCreate(origin, { ...created, sessionId: 'temporary-earlier-work' },
      { assistantSessionId: 'previous-assistant', requestId: 'earlier-create' }, 1);
    t.metadata.renameSessionMutationResults('temporary-earlier-work', 'canonical-earlier-work', 2);
    const ordinary = { ...origin, method: 'session.send', idempotencyKey: 'old-send' };
    t.metadata.claimMutation(ordinary, 1);
    t.metadata.completeMutation(ordinary, { accepted: true }, 0, 1);
    t.metadata.close(); t.metadata.start();
    expect([...t.metadata.feishuWorkOrigins('previous-assistant')]).toEqual([
      { assistantId: 'previous-assistant', sessionId: 'canonical-earlier-work' },
    ]);
    expect(t.metadata.claimMutation(ordinary).state).toBe('claimed');
    expect(t.metadata.claimMutation(origin)).toMatchObject({ state: 'completed',
      result: { sessionId: 'canonical-earlier-work' } });
    expect([...t.metadata.feishuWorkOrigins('unrelated-assistant')]).toEqual([]);
  });

  it('pages provenance without holding SQLite open while a caller publishes changes', async () => {
    const t = createFeishuWorkHarness();
    const created = await t.service.create('assistant-a', t.args);
    for (let index = 0; index < 260; index += 1) {
      const identity = { connectionScope: 'feishu-assistant:creator', accessSurface: 'feishu' as const,
        method: 'feishu.work.create', idempotencyKey: `create-${index}`, requestFingerprint: 'a'.repeat(64) };
      t.metadata.claimMutation(identity);
      t.metadata.commitFeishuWorkCreate(identity, { ...created, sessionId: `work-${index}` },
        { assistantSessionId: 'creator', requestId: identity.idempotencyKey });
    }
    const seen: string[] = [];
    for (const origin of t.metadata.feishuWorkOrigins('creator')) {
      seen.push(origin.sessionId);
      t.metadata.appendChange('session.updated', origin.sessionId, {});
    }
    expect(new Set(seen).size).toBe(260);
  });
});
