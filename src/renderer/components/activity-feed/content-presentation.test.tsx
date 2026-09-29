// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AgentEvent } from '@shared/types';
import { ActivityRecordsView } from './records-view';
import { eventImageBlobCache } from './image-context';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1cAAAAASUVORK5CYII=';
const IMAGE = { id: 'a'.repeat(64), name: 'generated.png', mime: 'image/png', bytes: 68 };
function event(kind: AgentEvent['kind'], payload: unknown, ts = 1): AgentEvent {
  return { sessionId: 'session', agentId: 'codex-cli', kind, payload, ts };
}
const props = { loaded: true, loadError: null, sessionId: 'session', agentId: 'codex-cli', isSdk: true };
afterEach(() => { cleanup(); eventImageBlobCache.clear(); Reflect.deleteProperty(window, 'api'); });

describe('session content presentation', () => {
  it('consolidates a tool call and preserves input disclosure through progress and completion', () => {
    const start = event('tool-use-start', { toolUseId: 'call', toolName: 'Bash', toolInput: { command: 'pnpm test' } });
    const { container, rerender } = render(<ActivityRecordsView {...props} events={[start]} />);
    fireEvent.click(screen.getByRole('button', { name: /Bash/ }));
    const end = event('tool-use-end', { toolUseId: 'call', toolName: 'Bash', toolResult: 'some output', error: 'exited early', status: 'failed', exitCode: 2 }, 3);
    rerender(<ActivityRecordsView {...props} events={[end, start]} />);
    expect(container.querySelectorAll('ol > li')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Bash/ }).getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('"command": "pnpm test"');
    expect(container.textContent).toContain('some output');
    expect(container.textContent).toContain('exited early');
    expect(container.textContent).toContain('退出码：2');
  });
  it('shows live output, accurate terminal outcomes and full subagent/compaction content', () => {
    const { container } = render(<ActivityRecordsView {...props} events={[
      event('tool-use-start', { toolUseId: 'live', toolName: 'Bash', aggregatedOutput: 'building package' }),
      event('finished', { ok: false, subtype: 'interrupted' }, 2),
      event('subagent-end', { subagentType: 'worker', lastAssistantMessage: 'Full child result' }, 3),
      event('context-compaction-end', { summary: 'x'.repeat(130) + 'complete ending' }, 4),
    ]} />);
    expect(container.textContent).toContain('执行输出');
    expect(container.textContent).toContain('building package');
    expect(container.textContent).toContain('一轮已中断');
    expect(container.textContent).toContain('Full child result');
    expect(container.textContent).toContain('complete ending');
  });
  it('does not render boolean error flags as failure text', () => {
    const { container } = render(<ActivityRecordsView {...props} events={[
      event('tool-use-end', { toolName: 'Bash', toolResult: 'done', error: false, status: 'completed' }),
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: /Bash/ }));
    expect(container.textContent).toContain('完成');
    expect(container.textContent).not.toContain('false');
    expect(container.querySelector('.bg-status-error\\/10')).toBeNull();
  });
  it('shows the persisted preview and truncation notice for oversized tool results', () => {
    const { container } = render(<ActivityRecordsView {...props} events={[
      event('tool-use-end', { __truncated: true, __preview: 'retained output preview' }),
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: /工具/ }));
    expect(container.textContent).toContain('记录内容已截断');
    expect(container.textContent).toContain('retained output preview');
  });
  it('shows a generated image, enlarges it and saves the same bytes locally', async () => {
    const loadImageBlob = vi.fn(async () => ({ ok: true as const, dataUrl: PNG, bytes: 68, mime: 'image/png' }));
    const saveImage = vi.fn(async () => ({ ok: true as const }));
    window.api = { loadImageBlob, saveImage } as unknown as typeof window.api;
    render(<ActivityRecordsView {...props} events={[event('tool-use-end', { toolName: 'ImageGeneration', images: [IMAGE], status: 'completed' })]} />);
    fireEvent.click(await screen.findByRole('button', { name: '放大图片：generated.png' }));
    expect(screen.getByRole('dialog', { name: '图片预览' })).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: '保存图片' }).at(-1)!);
    await waitFor(() => expect(saveImage).toHaveBeenCalledWith(PNG, 'generated.png'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(loadImageBlob).toHaveBeenCalledOnce();
  });
  it('routes Remote image reads through their source and never uses Local file IPC', async () => {
    const local = vi.fn();
    const remote = vi.fn(async () => ({ ok: true as const, dataUrl: PNG, bytes: 68, mime: 'image/png' }));
    window.api = { loadImageBlob: local } as unknown as typeof window.api;
    render(<ActivityRecordsView {...props} allowLocalAssets={false}
      imageReader={{ identity: 'remote-profile', load: remote }}
      events={[event('message', { role: 'assistant', text: 'image', images: [IMAGE] })]} />);
    await screen.findByRole('button', { name: '放大图片：generated.png' });
    expect(remote).toHaveBeenCalledWith('session', { kind: 'event-image', imageId: IMAGE.id });
    expect(local).not.toHaveBeenCalled();
  });
  it('keeps progress images after a status-only completion and respects explicit replacement', async () => {
    window.api = { loadImageBlob: async () => ({ ok: true, dataUrl: PNG, bytes: 68, mime: 'image/png' }) } as unknown as typeof window.api;
    const start = event('tool-use-start', { toolUseId: 'image', toolName: 'generate_image', images: [IMAGE] });
    const end = event('tool-use-end', { toolUseId: 'image', toolName: 'generate_image', status: 'completed' }, 2);
    const { rerender } = render(<ActivityRecordsView {...props} events={[end, start]} />);
    await screen.findByRole('button', { name: '放大图片：generated.png' });
    rerender(<ActivityRecordsView {...props} events={[{ ...end, payload: { ...end.payload as object, images: [] } }, start]} />);
    expect(screen.queryByRole('button', { name: '放大图片：generated.png' })).toBeNull();
  });
  it('renders provider plan states and priority under PLAN while retaining English thought labels', () => {
    render(<ActivityRecordsView {...props} events={[
      event('thinking', { plan: true, entries: [{ content: 'Inspect', status: 'in_progress', priority: 'high' }], text: '- [ ] Inspect' }),
      event('thinking', { text: '**Reasoning**' }, 2),
    ]} />);
    expect(screen.getByText('PLAN')).toBeTruthy();
    expect(screen.getByText('进行中 · high')).toBeTruthy();
    expect(screen.getByText('REASONING SUMMARY')).toBeTruthy();
    expect(screen.getByText('Reasoning').tagName).toBe('STRONG');
  });
});
