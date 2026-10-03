// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, FileChangePayload } from '@shared/types';
import { ActivityRecordsView } from './records-view';
import { registerBuiltinDiffRenderers } from '../diff/install';
import type { FileChangeReader } from '../diff/file-change-reader';

vi.mock('@renderer/lib/monaco-local', () => ({ configureLocalMonaco: vi.fn() }));
vi.mock('../diff/renderers/MonacoDiffEditor', () => ({ MonacoDiffEditor: ({ original, modified }: { original: string; modified: string }) => (
  <div data-testid="comparison"><span>{original}</span><span>{modified}</span></div>
) }));
registerBuiltinDiffRenderers();
afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'api'); });

function event(kind: AgentEvent['kind'], payload: Record<string, unknown>, ts = 1): AgentEvent {
  return { sessionId: 'session', agentId: 'claude-code', kind, payload, ts };
}

function editEvents(toolName = 'Edit', toolUseId = 'edit-1'): AgentEvent[] {
  const toolInput = { file_path: 'src/demo.ts', old_string: 'old', new_string: 'new',
    content: 'new', edits: [{ old_string: 'old', new_string: 'new' }] };
  return [
    event('tool-use-start', { toolName, toolUseId, toolInput }),
    event('tool-use-end', { toolName, toolUseId, status: 'completed', toolResult: 'Saved successfully' }, 2),
    event('file-changed', { filePath: 'src/demo.ts', toolCallId: toolUseId, kind: 'text',
      before: 'old', after: 'new', metadata: { source: toolName } }, 2),
  ];
}

function records(events: AgentEvent[], reader: FileChangeReader | null = null, isSdk = true) {
  return <ActivityRecordsView events={events} loaded loadError={null} sessionId="session"
    agentId="claude-code" isSdk={isSdk} allowLocalAssets={false} fileChangeReader={reader} />;
}

const stored: FileChangePayload = { id: 42, sessionId: 'session', filePath: 'src/demo.ts', kind: 'text',
  beforeBlob: 'old', afterBlob: 'new', beforeSnapshot: 'context\nold', afterSnapshot: 'context\nnew',
  toolCallId: 'edit-1', ts: 2, metadata: { source: 'Edit' } };

describe('tool calls and recorded file changes', () => {
  it.each(['Edit', 'Write', 'MultiEdit'])('shows one completed %s card with one diff disclosure', async (tool) => {
    const { container } = render(records(editEvents(tool).reverse()));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /查看改动/ })).toHaveLength(1);
    expect(container.textContent).toContain('完成');
    expect(container.textContent).toContain('查看输出');
    fireEvent.click(screen.getByRole('button', { name: /查看改动/ }));
    await waitFor(() => expect(screen.getByTestId('comparison').textContent).toContain('new'));
    expect(container.textContent).toContain('Saved successfully');
  });

  it('uses the stored full diff after completion and retains the input, output, and enlargement', async () => {
    const [start, end, change] = editEvents();
    const read = vi.fn(async () => stored);
    const reader = { identity: 'remote', read };
    const view = render(records([start], reader));
    expect(screen.getByRole('button', { name: '查看改动' })).toBeTruthy();
    view.rerender(records([{ ...change, payload: { filePath: stored.filePath, toolCallId: 'edit-1',
      kind: 'text', fileChangeId: 42 } }, end, start], reader));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /查看改动/ }));
    await waitFor(() => expect(screen.getByTestId('comparison').textContent).toContain('context\nold'));
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith('session', 42);
    fireEvent.click(screen.getByRole('button', { name: '放大' }));
    expect(screen.getByRole('dialog', { name: '放大改动视图' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    expect(view.container.textContent).toContain('"old_string": "old"');
    expect(view.container.textContent).toContain('Saved successfully');
  });

  it.each(['start', 'end'] as const)('keeps recorded diffs in the card when only the %s is loaded', async (kind) => {
    const [start, end, change] = editEvents();
    render(records([change, kind === 'start' ? start : end]));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /查看改动/ }));
    await waitFor(() => expect(screen.getByTestId('comparison').textContent).toContain('new'));
  });

  it('groups every changed file from a Grok tool without dropping any diff', async () => {
    const [start, end, change] = editEvents('write_file');
    const events = [start, end, change, { ...change, payload: { ...change.payload as object,
      filePath: 'src/other.ts', after: 'second file' } }].map((ev) => ({ ...ev, agentId: 'grok-build' }));
    render(records(events));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    const buttons = screen.getAllByRole('button', { name: /查看改动/ });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(screen.getByTestId('comparison').textContent).toContain('second file'));
  });

  it('keeps consecutive edits to the same file as separate operations', () => {
    render(records([...editEvents('Edit', 'first'), ...editEvents('Edit', 'second')].reverse()));
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    for (const row of screen.getAllByRole('listitem')) {
      expect(within(row).getAllByRole('button', { name: /查看改动/ })).toHaveLength(1);
    }
  });

  it('uses the same card shell and diff controls for Claude, Codex, and Grok', () => {
    const claude = editEvents();
    const grok = editEvents('write_file', 'grok').map((ev) => ({ ...ev, agentId: 'grok-build' }));
    const codex = { ...editEvents('apply_patch', 'codex')[2], agentId: 'codex-cli' };
    render(records([...claude, codex, ...grok]));
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.className)).size).toBe(1);
    for (const row of rows) {
      expect(within(row).getByText('完成')).toBeTruthy();
      expect(within(row).getAllByRole('button', { name: /查看改动/ })).toHaveLength(1);
    }
  });

  it('groups standalone Codex multi-file patches by call and retains independent edits', () => {
    const change = { ...editEvents('apply_patch', 'patch-1')[2], agentId: 'codex-cli' };
    const second = { ...change, payload: { ...change.payload as object, filePath: 'src/second.ts' } };
    const other = { ...change, payload: { ...change.payload as object, toolCallId: 'patch-2' } };
    render(records([change, second, other]));
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getAllByRole('button', { name: /查看改动/ })).toHaveLength(2);
    expect(within(rows[1]).getAllByRole('button', { name: /查看改动/ })).toHaveLength(1);
    expect(screen.queryByText('查看输出')).toBeNull();
  });

  it('retains standalone, uncorrelated, and Codex-only file changes', () => {
    const [start, end, change] = editEvents();
    render(records([start, end, change,
      { ...change, payload: { filePath: 'src/legacy.ts', before: 'a', after: 'b' } },
      { ...change, payload: { filePath: 'src/orphan.ts', toolCallId: 'missing' } },
      { ...change, agentId: 'codex-cli' },
    ]));
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getAllByRole('button', { name: /查看改动/ })).toHaveLength(4);
  });

  it('does not associate an identically named tool call from another session or adapter', () => {
    const [start, end, change] = editEvents();
    render(records([start, end, { ...change, sessionId: 'other-session' }, { ...change, agentId: 'grok-build' }]));
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it.each(['AskUserQuestion', 'ExitPlanMode'])('does not hide a diff behind the suppressed SDK %s row', (tool) => {
    render(records(editEvents(tool)));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /查看改动/ })).toBeTruthy();
  });

  it('also groups external CLI hook events and preserves specialized Agent cards', () => {
    render(records(editEvents('Agent'), null, false));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /查看改动/ })).toBeTruthy();
  });

  it('never substitutes local reads or the input snippet when a remote diff reader is unavailable', async () => {
    const local = vi.fn();
    window.api = { getFileChange: local } as unknown as Window['api'];
    const [start, end, change] = editEvents();
    render(records([start, end, { ...change, payload: { ...change.payload as object, fileChangeId: 42 } }]));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /查看改动/ }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '此来源暂不支持读取文件改动。');
    expect(screen.queryByTestId('comparison')).toBeNull();
    expect(local).not.toHaveBeenCalled();
  });

  it.each(['Read', 'Bash'])('keeps one %s row with its failure and output when no file change exists', (tool) => {
    const [start, end] = editEvents(tool);
    const events = [start, { ...end, payload: { ...end.payload as object, status: 'failed', toolResult: 'Access denied' } }];
    const { container } = render(records(events));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(container.textContent).toContain('失败');
    expect(container.textContent).toContain('Access denied');
    expect(screen.queryByRole('button', { name: /查看改动/ })).toBeNull();
  });
});
