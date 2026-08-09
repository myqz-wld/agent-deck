import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MCP_DIFF_PRESENTATION_SCHEMA,
  MCP_PLAN_PRESENTATION_SCHEMA,
} from '@contracts/index';

import { ServerCoreMcpPresentation } from './mcp-presentation';

afterEach(() => vi.useRealTimers());

function harness() {
  const changes: Array<{ kind: string; entityId: string }> = [];
  let sequence = 0;
  const service = new ServerCoreMcpPresentation({
    createId: () => `request-${++sequence}`,
    now: () => 1_000,
    appendChange: (kind, entityId) => { changes.push({ kind, entityId }); },
  });
  return { changes, service };
}

describe('ServerCoreMcpPresentation', () => {
  it('blocks a plan until the authoritative session approves it', async () => {
    const { changes, service } = harness();
    await service.start();
    const pending = service.requestPlan('session-a', { title: 'Plan', plan: '# Steps' });
    const [request] = service.list('session-a');
    expect(request).toMatchObject({
      id: 'mcp-exit-plan-request-1',
      kind: 'exit-plan',
      expiresAt: null,
      display: { schema: MCP_PLAN_PRESENTATION_SCHEMA, plan: '# Steps' },
    });
    expect(service.list('session-b')).toEqual([]);
    expect(service.respond('session-b', request!.id, 'accept')).toBeNull();
    expect(service.respond('session-a', request!.id, 'accept')).toBe('resolved');
    await expect(pending).resolves.toEqual({ decision: 'approved' });
    expect(changes).toEqual([{ kind: 'pending.created', entityId: 'session-a' }]);
    await service.stop();
  });

  it('returns revision feedback and expires a bounded diff gate', async () => {
    vi.useFakeTimers();
    const { service } = harness();
    await service.start();
    const revised = service.requestDiff('session-a', {
      mode: 'pr',
      rationale: 'Check behavior',
      pr: { before: 'old', after: 'new' },
      timeoutMs: 5_000,
    });
    const [request] = service.list('session-a');
    expect(request?.display.schema).toBe(MCP_DIFF_PRESENTATION_SCHEMA);
    expect(service.respond('session-a', request!.id, 'reject', {
      feedback: 'Keep the old fallback',
    })).toBe('denied');
    await expect(revised).resolves.toEqual({
      decision: 'revise',
      feedback: 'Keep the old fallback',
    });

    const timedOut = service.requestDiff('session-a', {
      mode: 'merge-conflict',
      rationale: 'Resolve conflict',
      conflict: { ours: 'a', theirs: 'b', resolution: 'c' },
      timeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(timedOut).resolves.toEqual({ decision: 'timeout' });
    expect(service.list('session-a')).toEqual([]);
    await service.stop();
  });

  it('renames pending ownership and releases only the exact session', async () => {
    const { service } = harness();
    await service.start();
    const first = service.requestPlan('session-a', { plan: 'first' });
    const second = service.requestPlan('session-b', { plan: 'second' });
    service.renameSession('session-a', 'session-c');
    expect(service.list('session-a')).toEqual([]);
    expect(service.list('session-c')).toHaveLength(1);
    service.releaseSession('session-c');
    await expect(first).resolves.toEqual({ decision: 'timeout' });
    expect(service.list('session-b')).toHaveLength(1);
    await service.stop();
    await expect(second).resolves.toEqual({ decision: 'timeout' });
  });

  it('stages handoff ownership before commit and restores only staged entries on rollback', async () => {
    const { service } = harness();
    await service.start();
    const source = service.requestPlan('session-a', { plan: 'source' });
    const successor = service.requestPlan('session-b', { plan: 'successor' });

    const rollback = service.prepareSessionTransfer('session-a', 'session-b');
    expect(service.list('session-a')).toEqual([]);
    expect(service.list('session-b')).toHaveLength(2);
    rollback.rollback();
    expect(service.list('session-a')).toHaveLength(1);
    expect(service.list('session-b')).toHaveLength(1);

    const commit = service.prepareSessionTransfer('session-a', 'session-b');
    commit.commit();
    expect(service.list('session-a')).toEqual([]);
    expect(service.list('session-b')).toHaveLength(2);
    service.releaseSession('session-b');
    await expect(source).resolves.toEqual({ decision: 'timeout' });
    await expect(successor).resolves.toEqual({ decision: 'timeout' });
    await service.stop();
  });

  it('rejects invalid payload combinations before publishing a gate', async () => {
    const { changes, service } = harness();
    await service.start();
    expect(() => service.requestDiff('session-a', {
      mode: 'pr',
      rationale: 'invalid path',
      filePath: '/host/private.ts',
      pr: { before: '', after: '' },
    })).toThrow(/filePath/);
    expect(changes).toEqual([]);
    expect(() => service.prepareSessionTransfer('session-a', '../invalid'))
      .toThrow('target session');
    await service.stop();
  });
});
