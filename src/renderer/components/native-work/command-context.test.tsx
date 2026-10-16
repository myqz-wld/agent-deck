// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import type { AgentEvent } from '@shared/types';
import type { NativeWorkSnapshot } from '@shared/native-work';
import { ActivityRecordsView } from '../activity-feed/records-view';
import { NativeCommandContext, useNativeCommand } from './command-context';
import { DisclosureScopeProvider, clearNativeWorkPreferences } from './preferences';
import type { NativeWorkTransport } from './transport';

const scope = 'command-conversation-test';
const task: NativeWorkSnapshot = { native: { sessionId: 'parent', provider: 'claude-code', nativeId: 'shell', runId: 'run', runtimeId: 'runtime' },
  taskId: 'shell', runId: 'run', workKind: 'shell', description: 'Background command', status: 'running', toolUseId: 'call',
  startedAt: 1, updatedAt: 10, revision: 1, detailStatus: 'available', canStop: true };
const start: AgentEvent = { sessionId: 'parent', agentId: 'claude-code', kind: 'tool-use-start', ts: 1,
  payload: { toolUseId: 'call', toolName: 'Bash', toolInput: { command: 'printf result' } } };
const end: AgentEvent = { ...start, kind: 'tool-use-end', ts: 2,
  payload: { toolUseId: 'call', toolName: 'Bash', status: 'completed', toolResult: 'Registered in background', exitCode: 0, durationMs: 5 } };
afterEach(() => { cleanup(); clearNativeWorkPreferences(scope); });

describe('background commands in their conversation row', () => {
  it.each(['claude-code', 'grok-build'] as const)('keeps one %s Bash row, lazily reading live output and final state', async provider => {
    let current = { ...task, native: { ...task.native, provider } };
    const details = vi.fn<NativeWorkTransport['details']>(async ({ order }) => {
      expect(order).toBe('asc');
      return { records: [{ native: current.native, recordId: 'output', id: 1, recordRevision: current.revision,
        kind: 'output', text: `stream ${current.revision}`, part: 0, parts: 1, ts: 2, sourceTruncated: false }], nextCursor: null, revision: current.revision };
    });
    const transport: NativeWorkTransport = { list: async () => ({ tasks: [current], revision: 1, nextCursor: null }),
      details, stop: async () => ({ status: 'accepted' }) };
    const tree = () => <DisclosureScopeProvider scope={scope}>
      <NativeCommandContext.Provider value={{ tasks: [current], transport }}>
        <ActivityRecordsView events={[{ ...end, agentId: provider }, { ...start, agentId: provider }]} loaded loadError={null}
          sessionId="parent" agentId={provider} isSdk allowLocalAssets={false} />
      </NativeCommandContext.Provider>
    </DisclosureScopeProvider>;
    const ui = render(tree());
    expect(ui.getAllByText('Bash')).toHaveLength(1);
    expect(ui.getByText('执行中')).toBeTruthy();
    expect(ui.queryByText('5ms')).toBeNull();
    expect(details).not.toHaveBeenCalled();
    const disclosure = ui.getByText('执行输出').closest('details')!;
    disclosure.open = true; fireEvent(disclosure, new Event('toggle'));
    await waitFor(() => expect(ui.getByText('stream 1')).toBeTruthy());
    expect(ui.queryByText('Registered in background')).toBeNull();
    current = { ...current, status: 'completed', revision: 2, updatedAt: 20 };
    ui.rerender(tree());
    await waitFor(() => expect(ui.getByText('stream 2')).toBeTruthy());
    expect(ui.getByText('完成')).toBeTruthy();
    expect(ui.getByText('查看输出').closest('details')?.open).toBe(true);
    expect(ui.getByRole('log').children).toHaveLength(1);
  });

  it('leaves Codex original command status and output intact without a second detail query', () => {
    const details = vi.fn();
    const transport: NativeWorkTransport = { list: vi.fn(), details, stop: vi.fn() };
    const ui = render(<NativeCommandContext.Provider value={{ tasks: [{ ...task, native: { ...task.native, provider: 'codex-cli' } }], transport }}>
      <ActivityRecordsView events={[{ ...end, agentId: 'codex-cli' }, { ...start, agentId: 'codex-cli' }]} loaded loadError={null}
        sessionId="parent" agentId="codex-cli" isSdk allowLocalAssets={false} />
    </NativeCommandContext.Provider>);
    expect(ui.getByText('完成')).toBeTruthy();
    const disclosure = ui.getByText('查看输出').closest('details')!;
    disclosure.open = true; fireEvent(disclosure, new Event('toggle'));
    expect(ui.getByText('Registered in background')).toBeTruthy();
    expect(details).not.toHaveBeenCalled();
  });

  it('requires exact session, provider, tool and child owner, without guessing missing legacy associations', () => {
    const transport: NativeWorkTransport = { list: vi.fn(), details: vi.fn(), stop: vi.fn() };
    let tasks = [task];
    const wrapper = ({ children }: PropsWithChildren) => <NativeCommandContext.Provider value={{ tasks, transport }}>{children}</NativeCommandContext.Provider>;
    const hook = renderHook(({ event }: { event: AgentEvent }) => useNativeCommand(event), { wrapper, initialProps: { event: end } });
    expect(hook.result.current?.task).toBe(task);
    for (const patch of [
      { toolUseId: undefined }, { toolUseId: 'other' }, { parentTaskId: 'child' }, { workKind: 'subagent' as const },
      { native: { ...task.native, sessionId: 'another-session' } },
      { native: { ...task.native, provider: 'grok-build' as const } },
    ]) {
      tasks = [{ ...task, ...patch }]; hook.rerender({ event: end });
      expect(hook.result.current).toBeNull();
    }
    tasks = [{ ...task, parentTaskId: 'child', toolUseKey: 'opaque-tool-key' }];
    const childEvent = { ...end, payload: { ...(end.payload as object), toolUseId: 'namespaced-call',
      nativeWorkOwner: 'child', nativeWorkToolUseId: 'opaque-tool-key' } };
    hook.rerender({ event: childEvent });
    expect(hook.result.current?.task).toBe(tasks[0]);
    hook.rerender({ event: { ...childEvent, payload: { ...childEvent.payload, nativeWorkOwner: 'another-child' } } });
    expect(hook.result.current).toBeNull();
  });
});
