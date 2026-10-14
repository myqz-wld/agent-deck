// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgentEvent } from '@shared/types';
import { CompactionRow } from './compaction-row';
import { SimpleRow } from './simple-row';
import { BackgroundTaskRow } from './background-task-row';

vi.mock('@renderer/components/MarkdownText', () => ({ MarkdownText: ({ text }: { text: string }) => <p>{text}</p> }));
afterEach(cleanup);
const event = (kind: AgentEvent['kind'], payload: unknown): AgentEvent => ({
  sessionId: 'example', agentId: 'codex-cli', ts: 1000, kind, payload,
});

describe('unified status presentation', () => {
  it('collapses complete evidence and makes the disclosure keyboard-accessible', () => {
    render(<CompactionRow event={event('context-compaction-end', {
      compaction: { status: 'completed', preTokens: 967260, postTokens: 14639, durationMs: 111670, summary: 'retained summary' },
    })} />);
    expect(screen.getByText('967.3k → 14.6k Token')).toBeTruthy();
    expect(screen.getByText('1分52秒')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Codex：上下文已压缩，展开详情' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const panel = document.getElementById(button.getAttribute('aria-controls')!)!;
    expect(panel.hidden).toBe(true);
    fireEvent.click(button);
    expect(panel.hidden).toBe(false);
    expect(panel.textContent).toContain('967,260 Token');
    expect(panel.textContent).toContain('retained summary');
  });
  it('shows no empty disclosure or made-up statistics for metadata-free completion', () => {
    render(<CompactionRow event={event('context-compaction-end', {})} />);
    expect(screen.getByText('上下文已压缩')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.body.textContent).not.toContain('Token');
  });
  it('keeps interrupted turns neutral and failed turns visibly distinct', () => {
    const { rerender, container } = render(<SimpleRow event={event('finished', { ok: false, subtype: 'interrupted' })} />);
    expect(screen.getByText('一轮已中断').className).not.toContain('text-status-error');
    expect(container.querySelector('li')?.className).not.toContain('border-status-error');
    rerender(<SimpleRow event={event('finished', { ok: false, subtype: 'error' })} />);
    expect(container.querySelector('li')?.className).toContain('border-status-error');
  });
  it('keeps background summaries in the same collapsed disclosure', () => {
    render(<BackgroundTaskRow event={event('background-task', {
      taskId: 'task-a', status: 'completed', summary: 'long retained background summary', description: 'Example task',
    })} />);
    const button = screen.getByRole('button', { name: /后台任务.*展开详情/ });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(button.getAttribute('aria-controls')!)?.textContent).toContain('long retained background summary');
  });
});
