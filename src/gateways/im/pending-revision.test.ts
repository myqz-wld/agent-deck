import { describe, expect, it } from 'vitest';
import { createPermissionPreviewDisplay } from '@contracts/index';
import { actionEvent, actionFrom, messageEvent, onlyClient, pending, select, setup } from './__tests__/fixture';

describe('approval revision races', () => {
  it.each([false, true])('revalidates after a Core CAS race; changed parameters=%s', async changed => {
    const f = setup();
    try {
      await select(f.gateway);
      const client = onlyClient(f.clients);
      client.pending.set('session-1', [pending()]);
      await f.gateway.handle(messageEvent('show', '/pending'));
      const action = actionFrom(f.transport.messages.at(-1)!);
      let attempts = 0;
      client.requestHook = call => {
        if (call.method === 'pending.respond' && ++attempts === 1) {
          client.revision++;
          if (changed) client.pending.set('session-1', [{ ...pending(),
            display: createPermissionPreviewDisplay('Bash', { command: 'different' }) }]);
          throw Object.assign(new Error('Revision changed before invocation'), { code: 'conflict' });
        }
      };
      const result = await f.gateway.handle(actionEvent('click', action));
      expect(result.code).toBe(changed ? 'pending_context_changed' : 'accepted');
      expect(attempts).toBe(changed ? 1 : 2);
      if (changed) expect(result.toast).toBe('审批内容已变化，请刷新待确认事项后重新确认。');
      const calls = client.calls.filter(c => c.method === 'pending.respond');
      expect(new Set(calls.map(c => c.options?.idempotencyKey)).size).toBe(1);
      if (!changed) expect(calls[1].options?.expectedRevision).toBe(action.revision + 1);
    } finally { await f.gateway.close(); }
  });

  it('does not retry an ambiguous provider outcome or accept a regressed Core revision', async () => {
    const f = setup();
    try {
      await select(f.gateway);
      const client = onlyClient(f.clients);
      client.pending.set('session-1', [pending()]);
      await f.gateway.handle(messageEvent('show', '/pending'));
      const action = actionFrom(f.transport.messages.at(-1)!);
      client.revision--;
      expect((await f.gateway.handle(actionEvent('regression', action))).code).toBe('pending_context_changed');
      expect(client.calls.filter(c => c.method === 'pending.respond')).toHaveLength(0);
      client.revision++;
      client.requestHook = call => { if (call.method === 'pending.respond') throw Object.assign(new Error('Unknown outcome'), { code: 'provider_lost' }); };
      expect((await f.gateway.handle(actionEvent('ambiguous', action))).code).toBe('provider_lost');
      expect(client.calls.filter(c => c.method === 'pending.respond')).toHaveLength(1);
    } finally { await f.gateway.close(); }
  });
});
