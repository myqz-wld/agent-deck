// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgentEvent } from '@shared/types';
import { ToolResultContent } from './rows/tool-result';
import { SimpleRow } from './rows/simple-row';
import { formatToolDuration } from './tool-status';

function event(payload: unknown, kind: AgentEvent['kind'] = 'tool-use-end'): AgentEvent {
  return { sessionId: 'test-session', agentId: 'claude-code', ts: 1, kind, payload };
}
afterEach(cleanup);

describe('readable tool results', () => {
  it.each(['Read', 'read_file'])('shows %s file text and retains the complete raw result on demand', (toolName) => {
    const result = { type: 'text', file: { filePath: 'sample.txt', content: 'first line\nsecond line', numLines: 2 } };
    const { container } = render(<ToolResultContent event={event({ toolName, toolResult: result })} />);
    expect(container.querySelector('pre')?.textContent).toBe('first line\nsecond line');
    expect(container.textContent).not.toContain('numLines');
    fireEvent.click(screen.getByRole('button', { name: '查看原始数据' }));
    expect(container.querySelectorAll('pre')[1].textContent).toBe(JSON.stringify(result, null, 2));
  });

  it.each(['Bash', 'run_terminal_command'])('keeps %s stdout, stderr and independent errors visible', (toolName) => {
    const { container } = render(<ToolResultContent event={event({
      toolName, toolResponse: { stdout: 'first\nsecond', stderr: 'a warning', interrupted: false },
      error: 'process failed', status: 'failed', exitCode: 2,
    })} />);
    expect(screen.getByText('标准输出')).toBeTruthy();
    expect(screen.getByText('标准错误')).toBeTruthy();
    expect(container.textContent).toContain('process failed');
    expect(container.textContent).toContain('退出码：2');
    expect([...container.querySelectorAll('pre')].map((pre) => pre.textContent)).toEqual([
      'process failed', 'first\nsecond', 'a warning',
    ]);
    expect(container.textContent).not.toContain('interrupted');
  });

  it('extracts MCP text while keeping unknown content and envelope metadata accessible', () => {
    const result = { content: [{ type: 'text', text: 'MCP line one\nline two' },
      { type: 'resource_link', uri: 'https://example.test/report' }], structuredContent: { count: 2 } };
    const { container } = render(<ToolResultContent event={event({ toolName: 'mcp__demo__query', toolResult: result })} />);
    expect(container.querySelector('pre')?.textContent).toBe('MCP line one\nline two');
    expect(container.textContent).toContain('https://example.test/report');
    fireEvent.click(screen.getByRole('button', { name: '查看原始数据' }));
    expect(container.textContent).toContain('structuredContent');
  });

  it('keeps unknown objects as JSON and does not reinterpret JSON-looking text', () => {
    const { container, rerender } = render(<ToolResultContent event={event({ toolResult: { arbitrary: 'a\nb' } })} />);
    expect(container.querySelector('pre')?.textContent).toBe('{\n  "arbitrary": "a\\nb"\n}');
    expect(screen.queryByRole('button', { name: '查看原始数据' })).toBeNull();
    rerender(<ToolResultContent event={event({ toolResult: '{"stdout":"literal\\ntext"}' })} />);
    expect(container.querySelector('pre')?.textContent).toBe('{"stdout":"literal\\ntext"}');
  });

  it('shows meaningful structured MCP output when no text content is available', () => {
    const { container } = render(<ToolResultContent event={event({ toolResult: {
      content: [], structuredContent: { result: 'complete', count: 3 },
    } })} />);
    expect(container.querySelector('pre')?.textContent).toBe('{\n  "result": "complete",\n  "count": 3\n}');
    expect(container.textContent).not.toContain('无文本输出');
  });

  it('keeps raw image data out of the primary text while retaining raw inspection', () => {
    const { container } = render(<ToolResultContent event={event({ toolResult: {
      type: 'content', content: { type: 'image', data: 'synthetic-image-data', mimeType: 'image/png' },
    } })} />);
    expect(container.textContent).not.toContain('synthetic-image-data');
    fireEvent.click(screen.getByRole('button', { name: '查看原始数据' }));
    expect(container.textContent).toContain('synthetic-image-data');
  });

  it('preserves live fallback text but does not replace an explicitly empty shell result with stale progress', () => {
    const { container, rerender } = render(<ToolResultContent event={event({ toolResult: '' })} fallbackOutput="live output" />);
    expect(container.textContent).toContain('live output');
    rerender(<ToolResultContent event={event({ toolName: 'Bash', toolResult: { stdout: '', stderr: '' } })} fallbackOutput="stale progress" />);
    expect(container.textContent).not.toContain('stale progress');
    expect(container.textContent).toContain('无文本输出');
  });

  it('hides empty metadata and retains meaningful zero values and task entries', () => {
    const { container, rerender } = render(<SimpleRow event={event({ backgroundTasks: [], sessionCrons: [], description: ' ', phase: {} }, 'finished')} />);
    expect(container.querySelector('details')).toBeNull();
    rerender(<SimpleRow event={event({ backgroundTasks: [{ id: 'task-one' }], sessionCrons: 0 }, 'finished')} />);
    expect(container.textContent).toContain('task-one');
    expect(container.textContent).toContain('定时任务：0');
  });

  it('distinguishes sub-millisecond, zero and missing duration', () => {
    expect(formatToolDuration(0.2)).toBe('<1ms');
    expect(formatToolDuration(0)).toBe('0ms');
    expect(formatToolDuration(undefined)).toBeNull();
    expect(formatToolDuration(10.4)).toBe('10ms');
  });
});
