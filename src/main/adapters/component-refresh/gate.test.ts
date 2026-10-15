import { describe, expect, it, vi } from 'vitest';
import { ComponentRefreshGate } from './gate';
import { assertComponentRefreshAvailable, withComponentRuntimeMutation } from './runtime-mutation';
const unchanged = { results: [{ component: 'skills' as const, outcome: 'unchanged' as const, detail: '' }] };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const state = { idle: false, current: true };
  const wake = vi.fn(); const emit = vi.fn();
  const gate = new ComponentRefreshGate({ idle: () => state.idle, current: () => state.current, wake, emit });
  return { state, wake, emit, gate };
}

describe('component refresh input reservation', () => {
  it('reserves before checking idle and merges queued explicit revisions', async () => {
    const { gate, state, wake } = fixture(); const old = vi.fn(); const latest = vi.fn(async () => unchanged);
    gate.request(old); gate.request(latest);
    expect(gate.blocked).toBe(true); expect(old).not.toHaveBeenCalled();
    state.idle = true; await gate.checkpoint();
    expect(latest).toHaveBeenCalledOnce(); expect(old).not.toHaveBeenCalled();
    expect(gate.snapshot()).toMatchObject({ phase: 'completed', revision: 2 });
    expect(gate.blocked).toBe(false); expect(wake).toHaveBeenCalledOnce();
  });
  it('cancels only the refresh reservation without touching model work or messages', async () => {
    const { gate, state, wake } = fixture(); const apply = vi.fn();
    gate.request(apply); expect(gate.cancel().phase).toBe('cancelled');
    state.idle = true; await gate.checkpoint();
    expect(apply).not.toHaveBeenCalled(); expect(gate.blocked).toBe(false); expect(wake).toHaveBeenCalledOnce();
  });
  it('keeps input gated throughout applying and refuses user cancellation of native work', async () => {
    const { gate, state } = fixture(); const wait = deferred(); state.idle = true;
    gate.request(async () => { await wait.promise; return unchanged; });
    expect(gate.cancel().phase).toBe('applying'); expect(gate.blocked).toBe(true);
    wait.resolve(); await gate.checkpoint(); expect(gate.blocked).toBe(false);
  });
  it.each(['close', 'handoff', 'cwd change', 'runtime replacement'])(
    'invalidates a queued operation on %s without redirecting it', async () => {
      const { gate, state } = fixture(); const apply = vi.fn(); gate.request(apply);
      gate.invalidate(); state.idle = true; await gate.checkpoint();
      expect(apply).not.toHaveBeenCalled(); expect(gate.snapshot().phase).toBe('cancelled');
    },
  );
  it('checks identity after asynchronous native work and suppresses stale success', async () => {
    const { gate, state, emit } = fixture(); const wait = deferred(); state.idle = true;
    gate.request(async assertCurrent => { await wait.promise; assertCurrent(); return unchanged; });
    state.current = false; wait.resolve(); await gate.checkpoint();
    expect(gate.snapshot().phase).toBe('cancelled');
    expect(emit.mock.calls.some(([status]) => status.phase === 'completed')).toBe(false);
  });
  it('releases the gate after failure and preserves per-component partial outcomes', async () => {
    const { gate, state } = fixture(); state.idle = true;
    gate.request(async () => { throw new Error('native failure'); }); await gate.checkpoint();
    expect(gate.snapshot().phase).toBe('failed'); expect(gate.blocked).toBe(false);
    gate.request(async () => ({ results: [...unchanged.results,
      { component: 'plugins', outcome: 'cache-deferred', detail: 'held' }] })); await gate.checkpoint();
    expect(gate.snapshot().phase).toBe('partial');
  });

  it('holds the next input while native idle evidence is pending and cancels only that read', async () => {
    const check = deferred(); const apply = vi.fn(async () => unchanged);
    let signal!: AbortSignal;
    const gate = new ComponentRefreshGate({ current: () => true, idle: () => true, wake: vi.fn(), emit: vi.fn(),
      idleCheck: async input => { signal = input; await check.promise; return true; } });
    gate.request(apply); expect(gate.blocked).toBe(true); expect(apply).not.toHaveBeenCalled();
    expect(gate.cancel().phase).toBe('cancelled'); expect(signal.aborted).toBe(true);
    check.resolve(); await gate.checkpoint(); await Promise.resolve();
    expect(apply).not.toHaveBeenCalled(); expect(gate.blocked).toBe(false);
  });

  it('waits for background consumers, then applies only the latest explicit target', async () => {
    vi.useFakeTimers();
    try {
      let busy = true;
      const first = vi.fn(async () => unchanged); const last = vi.fn(async () => unchanged);
      const gate = new ComponentRefreshGate({ current: () => true, idle: () => true, wake: vi.fn(), emit: vi.fn(),
        idleCheck: async () => !busy });
      gate.request(first); await gate.checkpoint(); gate.request(last);
      await vi.advanceTimersByTimeAsync(1000);
      expect(last).not.toHaveBeenCalled(); expect(gate.blocked).toBe(true);
      busy = false; await vi.advanceTimersByTimeAsync(1000);
      expect(first).not.toHaveBeenCalled(); expect(last).toHaveBeenCalledOnce();
      expect(gate.snapshot().phase).toBe('completed');
    } finally { vi.useRealTimers(); }
  });

  it('fails closed when native background state cannot be read', async () => {
    const apply = vi.fn();
    const gate = new ComponentRefreshGate({ current: () => true, idle: () => true, wake: vi.fn(), emit: vi.fn(),
      idleCheck: async () => { throw new Error('unknown method'); } });
    gate.request(apply); await gate.checkpoint();
    expect(gate.snapshot().phase).toBe('failed'); expect(apply).not.toHaveBeenCalled();
    expect(gate.blocked).toBe(false);
  });

  it('withdraws a coalesced follow-up without interrupting the refresh already applying', async () => {
    const { gate, state } = fixture(); state.idle = true; const wait = deferred();
    const next = vi.fn(async () => unchanged);
    gate.request(async () => { await wait.promise; return unchanged; }); gate.request(next);
    gate.cancel(); expect(gate.blocked).toBe(true); wait.resolve(); await gate.checkpoint();
    expect(next).not.toHaveBeenCalled(); expect(gate.snapshot().phase).toBe('completed');
  });

  it('serializes runtime settings with refresh while leaving permission replies independent', async () => {
    const { gate, state } = fixture(); const runtime = { componentRefresh: gate }; const work = deferred();
    const apply = vi.fn(); gate.request(apply);
    const mutation = withComponentRuntimeMutation(runtime, () => work.promise);
    expect(gate.snapshot().phase).toBe('cancelled');
    expect(() => assertComponentRefreshAvailable(runtime)).toThrow(/切换/);
    work.resolve(); await mutation; expect(() => assertComponentRefreshAvailable(runtime)).not.toThrow();
    expect(apply).not.toHaveBeenCalled();
    const next = fixture(); next.state.idle = true; const native = deferred();
    next.gate.request(async () => { await native.promise; return unchanged; });
    const change = vi.fn(async () => {});
    await expect(withComponentRuntimeMutation({ componentRefresh: next.gate }, change)).rejects.toThrow(/正在应用/);
    expect(change).not.toHaveBeenCalled(); native.resolve(); await next.gate.checkpoint();
    state.idle = true;
  });
});
