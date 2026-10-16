// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { nativeWorkAttemptKey, type NativeWorkSnapshot } from '@shared/native-work';
import type { NativeWorkTransport } from './transport';
import { useNativeWork } from './useNativeWork';
import { NativeWorkStrip } from './NativeWorkStrip';
import { NativeWorkDetails } from './NativeWorkDetails';
import { DisclosureScopeProvider, clearNativeWorkPreferences, updateNativeWorkPreferences } from './preferences';
import { SessionDetailShell, createSessionDetailTabs } from '../SessionDetail/SessionDetailShell';
import { MessageBubble } from '../activity-feed/rows/message-row';
const scope = 'test-client:test-host:test-session';
const task: NativeWorkSnapshot = { native: { sessionId: 's', provider: 'codex-cli', nativeId: 'child', runId: 'run', runtimeId: 'runtime' },
  taskId: 'child', runId: 'run', workKind: 'subagent', status: 'running', description: 'Inspect', startedAt: 1, updatedAt: 1,
  revision: 1, canStop: true, detailStatus: 'available' };
afterEach(() => { cleanup(); clearNativeWorkPreferences(scope); clearNativeWorkPreferences('other-host'); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture() {
  let tasks = [task];
  const stop = vi.fn(async () => ({ status: 'accepted' as const }));
  const transport: NativeWorkTransport = { list: async () => ({ tasks, revision: 1, nextCursor: null }),
    details: async () => ({ records: [], revision: 1, nextCursor: null }), stop };
  return { transport, stop, setTasks: (next: NativeWorkSnapshot[]) => { tasks = next; } };
}
describe('production native work interaction', () => {
  it('measures a remembered expanded card on first mount after asynchronous task loading', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const card = this.classList.contains('work-card-slot'), chat = this.hasAttribute('data-session-chat-area');
      const top = chat ? 0 : 250, width = card ? 440 : 1100, height = chat ? 200 : 50;
      return { left: 0, top, width, height, right: width, bottom: top + height, x: 0, y: top, toJSON() {} };
    });
    const { transport } = fixture();
    updateNativeWorkPreferences(scope, previous => ({ ...previous, expanded: [nativeWorkAttemptKey(task.native)] }));
    function Harness() {
      const view = useNativeWork('s', scope, transport);
      return <SessionDetailShell title="Session" sourceBadge={null} subtitle="Example" preferenceScope={scope}
        tabs={createSessionDetailTabs({ activity: null, tasks: null, diff: null, summary: null, messages: null })}
        activeTab="activity" onTabChange={() => {}} onClose={() => {}} composer={null} nativeWork={<NativeWorkStrip view={view} />} />;
    }
    const ui = render(<Harness />);
    await waitFor(() => expect(ui.getByRole('region', { name: 'Inspect详情' })).toBeTruthy());
  });
  it('omits the complete strip with no tasks', async () => {
    const { transport, setTasks } = fixture(); setTasks([]);
    const view = renderHook(() => useNativeWork('s', scope, transport));
    const ui = render(<NativeWorkStrip view={view.result.current} />);
    expect(ui.container.innerHTML).toBe('');
  });
  it('persists hide only on terminal confirmation, preserves history and reveals new runs', async () => {
    const { transport, setTasks } = fixture();
    const view = renderHook(() => useNativeWork('s', scope, transport));
    await waitFor(() => expect(view.result.current.visible).toHaveLength(1));
    await act(() => view.result.current.stop(task, true));
    expect(view.result.current.visible).toHaveLength(0);
    expect(view.result.current.preferences.hidden).toEqual([]);
    setTasks([{ ...task, status: 'stopped', revision: 2 }]);
    await act(() => view.result.current.refresh());
    expect(view.result.current.preferences.hidden).toEqual([nativeWorkAttemptKey(task.native)]);
    expect(view.result.current.tasks).toHaveLength(1);
    setTasks([{ ...task, runId: 'new-run', native: { ...task.native, runId: 'new-run' }, startedAt: 2 }]);
    await act(() => view.result.current.refresh());
    expect(view.result.current.visible).toHaveLength(1);
  });
  it('restores a dragged card on rejection and retains a separately stopped card', async () => {
    const { transport } = fixture();
    transport.stop = async () => ({ status: 'failed' });
    const view = renderHook(() => useNativeWork('s', scope, transport));
    await waitFor(() => expect(view.result.current.visible).toHaveLength(1));
    await act(() => view.result.current.stop(task, true));
    expect(view.result.current.visible).toHaveLength(1);
    expect(view.result.current.errors[nativeWorkAttemptKey(task.native)].hide).toBe(true);
    transport.stop = async () => ({ status: 'accepted' });
    await act(() => view.result.current.stop(task, false));
    expect(view.result.current.visible).toHaveLength(1);
  });
  it('restores after terminal confirmation times out and coalesces duplicate stopping', async () => {
    vi.useFakeTimers();
    const { transport, stop } = fixture();
    const view = renderHook(() => useNativeWork('s', scope, transport));
    await act(async () => {});
    await act(async () => { await Promise.all([view.result.current.stop(task, true), view.result.current.stop(task, true)]); });
    expect(stop).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(35001));
    expect(view.result.current.visible).toHaveLength(1);
    expect(view.result.current.errors[nativeWorkAttemptKey(task.native)].message).toContain('未收到停止确认');
  });
  it('remembers order and independent expansion per host/session across remounts', async () => {
    const { transport } = fixture(); const key = nativeWorkAttemptKey(task.native);
    const view = renderHook(() => useNativeWork('s', scope, transport));
    act(() => { view.result.current.expand(key, true); view.result.current.reorder([key]); });
    view.unmount();
    const reopened = renderHook(() => useNativeWork('s', scope, transport));
    expect(reopened.result.current.preferences.expanded).toEqual([key]);
    expect(reopened.result.current.preferences.order).toEqual([key]);
    const other = renderHook(() => useNativeWork('s', 'other-host', transport));
    expect(other.result.current.preferences.expanded).toEqual([]);
    expect(localStorage.getItem(`agent-deck:native-work-ui:v1:${scope}`)).not.toContain('Inspect');
  });
  it('renders task output as Markdown with an optional plaintext view', async () => {
    const { transport } = fixture();
    transport.details = async () => ({ records: [{ native: task.native, recordId: 'output', recordRevision: 1, id: 1,
      kind: 'output', text: '# Result\n\n**done**', part: 0, parts: 1, ts: 1, sourceTruncated: false }], revision: 1, nextCursor: null });
    const ui = render(<NativeWorkDetails task={task} transport={transport} />);
    await waitFor(() => expect(ui.getByRole('heading', { name: 'Result' })).toBeTruthy());
    fireEvent.click(ui.getByRole('button', { name: '纯文本' }));
    expect(ui.queryByRole('heading', { name: 'Result' })).toBeNull();
    expect(ui.container.querySelector('pre')?.textContent).toContain('**done**');
  });
  it('remembers message expansion with stable identity when text and stored row ID change', () => {
    const event = { sessionId: 's', agentId: 'codex-cli', kind: 'message' as const, ts: 10, payload: { messageId: 'message', role: 'assistant', text: 'Long text '.repeat(120) } };
    const ui = render(<DisclosureScopeProvider scope={scope}><MessageBubble event={event} agentId="codex-cli" /></DisclosureScopeProvider>);
    fireEvent.click(ui.getByRole('button', { name: /展开（/ })); ui.unmount();
    const next = render(<DisclosureScopeProvider scope={scope}><MessageBubble event={{ ...event, payload: { ...event.payload, text: event.payload.text + ' updated' } }} agentId="codex-cli" /></DisclosureScopeProvider>);
    expect(next.getByRole('button', { name: '收起' }).getAttribute('aria-expanded')).toBe('true');
  });
});
