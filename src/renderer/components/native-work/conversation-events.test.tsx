// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { NativeWorkDetail, NativeWorkSnapshot } from '@shared/native-work';
import { nativeWorkConversationEvents, type JoinedWorkRecord } from './conversation-events';
import { NativeWorkDetails } from './NativeWorkDetails';
import { DisclosureScopeProvider, clearNativeWorkPreferences } from './preferences';
import type { NativeWorkTransport } from './transport';
const task: NativeWorkSnapshot = { native: { sessionId: 'parent', provider: 'codex-cli', nativeId: 'child', runId: 'run', runtimeId: 'runtime' },
  taskId: 'child', runId: 'run', workKind: 'subagent', description: 'Inspect', status: 'running',
  startedAt: 1, updatedAt: 10, revision: 1, detailStatus: 'available', canStop: true };
const scope = 'child-conversation-test';
const record = (recordId: string, kind: NativeWorkDetail['kind'], text: string, extra: Partial<JoinedWorkRecord> = {}): JoinedWorkRecord => ({
  native: task.native, recordId, kind, text, ts: 1, recordRevision: 1, part: 0, parts: 1, sourceTruncated: false, incomplete: false, ...extra,
});
afterEach(() => { cleanup(); clearNativeWorkPreferences(scope); });
describe('native child conversation', () => {
  it('renders main-conversation bubbles, readable reasoning and one paired Bash row', async () => {
    const records = [record('prompt', 'message', 'Inspect the project', { role: 'user' }),
      record('reason', 'thinking', '["Checking the result"]'),
      record('start', 'tool-use-start', 'printf result', { toolUseId: 'call', toolName: 'Bash', toolStatus: 'completed' }),
      record('output', 'output', 'result', { toolUseId: 'call', toolName: 'Bash', toolStatus: 'completed', exitCode: 0 }),
      record('message', 'message', '# Result\n\n**Ready**')];
    const transport: NativeWorkTransport = { list: async () => ({ tasks: [task], nextCursor: null, revision: 1 }),
      details: async () => ({ records: records.map((value, id) => ({ ...value, id })), nextCursor: null, revision: 1 }),
      stop: async () => ({ status: 'accepted' }) };
    const ui = render(<NativeWorkDetails task={task} transport={transport} />);
    await waitFor(() => expect(ui.getByRole('heading', { name: 'Result' })).toBeTruthy());
    expect(ui.getByText('你')).toBeTruthy();
    expect(ui.getByText('REASONING SUMMARY')).toBeTruthy();
    expect(ui.getByText('Checking the result')).toBeTruthy();
    expect(ui.queryByText('["Checking the result"]')).toBeNull();
    expect(ui.getAllByText('Bash')).toHaveLength(1);
    expect(ui.getByText('查看输出')).toBeTruthy();
    const rows = Array.from(ui.getByRole('log').children);
    expect(rows[0].textContent).toContain('Result');
    expect(rows.at(-1)?.textContent).toContain('Inspect the project');
    expect(ui.queryByRole('button', { name: /^活动$/ })).toBeNull();
    expect(ui.queryByRole('button', { name: /^输出$/ })).toBeNull();
  });
  it('loads older records below the latest message and joins split text in its original order', async () => {
    const parts = [
      { ...record('old', 'message', 'Earlier message'), id: 1 },
      { ...record('latest', 'message', '# Latest\n\nFirst line.\n', { part: 0, parts: 2 }), id: 2 },
      { ...record('latest', 'message', '\nLast line.', { part: 1, parts: 2 }), id: 3 },
    ];
    const details = vi.fn<NativeWorkTransport['details']>(async ({ cursor, order }) => {
      expect(order).toBe('desc');
      return { records: cursor ? parts.slice(0, 1) : parts.slice(1).reverse(), nextCursor: cursor ? null : 2, revision: 1 };
    });
    const transport: NativeWorkTransport = { list: async () => ({ tasks: [task], nextCursor: null, revision: 1 }),
      details, stop: async () => ({ status: 'accepted' }) };
    const ui = render(<NativeWorkDetails task={task} transport={transport} />);
    await waitFor(() => expect(ui.getByRole('heading', { name: 'Latest' })).toBeTruthy());
    expect(ui.queryByText('Earlier message')).toBeNull();
    fireEvent.click(ui.getByRole('button', { name: '加载更早记录' }));
    await waitFor(() => expect(ui.getByText('Earlier message')).toBeTruthy());
    const rows = Array.from(ui.getByRole('log').children);
    expect(rows[0].textContent).toMatch(/Latest.*First line.*Last line/s);
    expect(rows[1].textContent).toContain('Earlier message');
    expect(ui.queryByRole('button', { name: '加载更早记录' })).toBeNull();
  });
  it('does not turn partial output into completion or interpret JSON stdout as a tool envelope', () => {
    const events = nativeWorkConversationEvents(task, [
      record('start', 'tool-use-start', '"literal command"', { toolUseId: 'call', toolName: 'Bash', toolStatus: 'inProgress' }),
      record('output', 'output', '{"content":"literal stdout"}', { toolUseId: 'call', toolName: 'Bash', toolStatus: 'inProgress' }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'tool-use-start', payload: {
      status: 'inProgress', toolInput: { command: '"literal command"' }, aggregatedOutput: '{"content":"literal stdout"}',
    } });
  });
  it('never pairs legacy adjacent records without an explicit tool identity', () => {
    const events = nativeWorkConversationEvents(task, [record('a', 'tool-use-start', '{"command":"pwd"}', { toolName: 'Bash' }),
      record('b', 'tool-use-end', 'result'), record('empty', 'thinking', '[]')]);
    expect(events).toHaveLength(2);
    for (const event of events) expect((event.payload as Record<string, unknown>).toolUseId).toBeUndefined();
  });
  it('keeps live output above earlier messages when its start is on an unloaded page', () => {
    const events = nativeWorkConversationEvents(task, [
      record('output', 'output', 'live text', { toolUseId: 'call', toolName: 'Bash', toolStatus: 'inProgress' }),
      record('earlier', 'message', 'Earlier message'),
    ]);
    expect(events.map(event => event.kind)).toEqual(['tool-use-start', 'message']);
    expect(events[0].payload).toMatchObject({ aggregatedOutput: 'live text', status: 'inProgress' });
  });
  it('keeps tool disclosure across output refresh and remount, scoped to the attempt', async () => {
    let revision = 1;
    const records = () => [record('start', 'tool-use-start', 'printf result', { toolUseId: 'call', toolName: 'Bash' }),
      record('output', 'output', `result ${revision}`, { toolUseId: 'call', toolName: 'Bash', toolStatus: 'completed', recordRevision: revision })];
    const transport: NativeWorkTransport = { list: async () => ({ tasks: [task], nextCursor: null, revision }),
      details: async () => ({ records: records().map((value, id) => ({ ...value, id })), nextCursor: null, revision }), stop: async () => ({ status: 'accepted' }) };
    const tree = () => <DisclosureScopeProvider scope={scope}><NativeWorkDetails task={{ ...task, revision }} transport={transport} /></DisclosureScopeProvider>;
    const ui = render(tree());
    await waitFor(() => expect(ui.getByText('查看输出')).toBeTruthy());
    const disclosure = ui.getByText('查看输出').closest('details')!;
    disclosure.open = true; fireEvent(disclosure, new Event('toggle'));
    ui.unmount(); revision++;
    const reopened = render(tree());
    await waitFor(() => expect(reopened.getByText('result 2')).toBeTruthy());
    expect(reopened.getByText('查看输出').closest('details')?.open).toBe(true);
    const projected = nativeWorkConversationEvents(task, records());
    const next = nativeWorkConversationEvents({ ...task, native: { ...task.native, runId: 'next' } }, records());
    expect((projected[0].payload as Record<string, unknown>).toolUseId).not.toBe((next[0].payload as Record<string, unknown>).toolUseId);
  });
});
