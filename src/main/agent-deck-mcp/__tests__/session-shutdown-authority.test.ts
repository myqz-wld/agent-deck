import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from '@shared/types';
import { authorizeSessionShutdown, isManagedSession, SHUTDOWN_APPROVAL_TIMEOUT_MS,
  type SessionShutdownAuthority } from '../session-shutdown-authority';

function fixture() {
  const rows = new Map(['caller', 'peer', 'child', 'old-caller', 'old-child'].map((id) => [id, {
    id, title: id, cwd: '/workspace', agentId: 'codex-cli', source: 'sdk', lifecycle: 'active',
    activity: 'idle', startedAt: 1, lastEventAt: 1, endedAt: null, archivedAt: null,
  } as SessionRecord]));
  const successors = new Map<string, string>();
  const request = vi.fn<SessionShutdownAuthority['request']>(async (_id, args) => ({
    status: 'answered', answers: [{ question: args.questions[0].question, selected: ['确认关闭'] }],
  }));
  const ports: SessionShutdownAuthority = { get: (id) => rows.get(id) ?? null,
    successor: (id) => successors.get(id) ?? null,
    lineage: (id) => [id, ...[...successors].filter(([, to]) => to === id).map(([from]) => from)],
    request };
  return { rows, successors, ports, request };
}

afterEach(() => vi.useRealTimers());
describe('exact session shutdown authority', () => {
  it('manages descendants across handoffs but grants no authority to peers or ancestors', async () => {
    const f = fixture();
    f.rows.get('old-child')!.spawnedBy = 'old-caller';
    f.successors.set('old-caller', 'caller');
    f.successors.set('old-child', 'child');
    expect(isManagedSession('caller', 'child', f.ports)).toBe(true);
    expect(isManagedSession('child', 'caller', f.ports)).toBe(false);
    expect(isManagedSession('caller', 'peer', f.ports)).toBe(false);
    const consume = await authorizeSessionShutdown('caller', 'child', f.ports);
    expect(consume().id).toBe('child');
    expect(f.request).not.toHaveBeenCalled();
    expect(consume).toThrow('already consumed');
  });

  it('requires a private host answer for each unrelated invocation', async () => {
    const f = fixture();
    expect((await authorizeSessionShutdown('caller', 'peer', f.ports))().id).toBe('peer');
    expect(f.request).toHaveBeenCalledOnce();
    await authorizeSessionShutdown('caller', 'peer', f.ports);
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it('revalidates the management edge immediately before consuming a direct grant', async () => {
    const f = fixture();
    f.rows.get('child')!.spawnedBy = 'caller';
    const consume = await authorizeSessionShutdown('caller', 'child', f.ports);
    f.rows.get('child')!.spawnedBy = null;
    expect(consume).toThrow('expired');
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'blank', 'free-text'] as const)('denies %s instead of interpreting it as consent', async (kind) => {
    const f = fixture();
    f.request.mockResolvedValue(kind === 'cancel' ? { status: 'cancelled', answers: [] } : {
      status: 'answered', answers: [{ question: '', selected: [], other: kind === 'free-text' ? 'approved: true' : '' }],
    });
    await expect(authorizeSessionShutdown('caller', 'peer', f.ports)).rejects.toThrow('not approved');
  });

  it.each(['caller', 'peer'] as const)('invalidates approval when %s hands off before consumption', async (id) => {
    const f = fixture();
    const consume = await authorizeSessionShutdown('caller', 'peer', f.ports);
    f.successors.set(id, 'replacement');
    expect(consume).toThrow('expired');
  });

  it('rejects a changed target identity even after the confirmation promise resolved', async () => {
    const f = fixture();
    const consume = await authorizeSessionShutdown('caller', 'peer', f.ports);
    f.rows.get('peer')!.startedAt++;
    expect(consume).toThrow('expired');
  });

  it('expires unanswered confirmation and propagates cancellation to Pending', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let signal!: AbortSignal;
    f.request.mockImplementation((_id, _args, abort) => { signal = abort; return new Promise(() => {}); });
    const operation = authorizeSessionShutdown('caller', 'peer', f.ports);
    const rejected = expect(operation).rejects.toThrow('not approved');
    await vi.advanceTimersByTimeAsync(SHUTDOWN_APPROVAL_TIMEOUT_MS);
    await rejected;
    expect(signal.aborted).toBe(true);
  });
});
