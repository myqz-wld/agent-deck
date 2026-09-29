// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, FileChangePayload } from '@shared/types';
import { ActivityRecordsView } from './records-view';
import type { FileChangeReader } from '../diff/file-change-reader';
import { registerBuiltinDiffRenderers } from '../diff/install';

vi.mock('@renderer/lib/monaco-local', () => ({ configureLocalMonaco: vi.fn() }));
vi.mock('@monaco-editor/react', () => ({ DiffEditor: ({ original, modified }: { original: string; modified: string }) => (
  <div data-testid="comparison"><span>{original}</span><span>{modified}</span></div>
) }));
registerBuiltinDiffRenderers();
afterEach(() => cleanup());

const event: AgentEvent = { sessionId: 'session', agentId: 'codex-cli', kind: 'file-changed', ts: 10,
  payload: { filePath: 'src/demo.ts', kind: 'text', fileChangeId: 42 } };
const stored: FileChangePayload = { id: 42, sessionId: 'session', filePath: 'src/demo.ts', kind: 'text',
  beforeBlob: null, afterBlob: null, beforeSnapshot: 'context\nold', afterSnapshot: 'context\nnew',
  toolCallId: 'tool', ts: 10, metadata: { source: 'codex', changeKind: 'update' } };
function records(reader: FileChangeReader | null, ev = event) {
  return <ActivityRecordsView events={[ev]} loaded loadError={null} sessionId={ev.sessionId}
    agentId={ev.agentId} isSdk allowLocalAssets={false} fileChangeReader={reader} />;
}
describe('inline recorded file changes', () => {
  it('loads only on expansion, reuses the record, and enlarges without looking up a file list', async () => {
    const read = vi.fn(async () => stored);
    render(records({ identity: 'remote', read }));
    expect(read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /查看改动/ }));
    await waitFor(() => expect(screen.getByTestId('comparison').textContent).toContain('context\nold'));
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith('session', 42);
    fireEvent.click(screen.getByRole('button', { name: '放大' }));
    expect(screen.getByRole('dialog', { name: '放大改动视图' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /收起改动/ }));
    fireEvent.click(screen.getByRole('button', { name: /查看改动/ }));
    await waitFor(() => expect(screen.getByTestId('comparison')).toBeTruthy());
    expect(read).toHaveBeenCalledOnce();
  });
  it('renders old Codex patch events directly without any payload request', async () => {
    const read = vi.fn();
    render(records({ identity: 'remote', read }, { ...event, payload: {
      filePath: 'README.md', kind: 'text', before: null, after: null,
      metadata: { source: 'codex', changeKind: 'update', diff: '@@ -1 +1 @@\n-old text\n+new text' },
    } }));
    fireEvent.click(screen.getByRole('button', { name: /查看改动/ }));
    await waitFor(() => expect(screen.getByTestId('comparison').textContent).toContain('new text'));
    expect(read).not.toHaveBeenCalled();
  });
  it('never falls back to Local reads when a Remote source lacks the capability', async () => {
    const local = vi.fn();
    window.api = { getFileChange: local } as unknown as Window['api'];
    render(records(null));
    fireEvent.click(screen.getByRole('button', { name: /查看改动/ }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '此来源暂不支持读取文件改动。');
    expect(local).not.toHaveBeenCalled();
  });
  it('retries a failed payload and rejects stale content from a different source', async () => {
    let resolve!: (value: FileChangePayload) => void;
    const old = { identity: 'remote-a', read: vi.fn(() => new Promise<FileChangePayload>((done) => { resolve = done; })) };
    const next = { identity: 'remote-b', read: vi.fn().mockRejectedValueOnce(new Error('连接中断')).mockResolvedValue(stored) };
    const view = render(records(old));
    fireEvent.click(screen.getByRole('button', { name: /查看改动/ }));
    await waitFor(() => expect(old.read).toHaveBeenCalled());
    view.rerender(records(next));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '连接中断重试');
    await act(async () => resolve({ ...stored, afterSnapshot: 'stale source' }));
    expect(screen.queryByText('stale source')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByTestId('comparison').textContent).toContain('context\nnew'));
  });
});
