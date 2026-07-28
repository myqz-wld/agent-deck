// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { SummarizerErrorsDiagnostic } from '../SummarizerErrorsDiagnostic';

afterEach(() => cleanup());

describe('SummarizerErrorsDiagnostic', () => {
  it('keeps the list bounded while exposing the complete selected diagnostic', async () => {
    const complete = `${'network failure '.repeat(30)}diagnostic tail`;
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        summarizerLastErrors: vi.fn().mockResolvedValue(Object.fromEntries(
          Array.from({ length: 7 }, (_, index) => [
            `session-${index}`,
            { message: index === 6 ? complete : `failure ${index}`, ts: index },
          ]),
        )),
      },
    });
    render(<SummarizerErrorsDiagnostic />);
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '展开完整诊断' })).toHaveLength(5);
    });
    expect(document.body.textContent).not.toContain('diagnostic tail');
    fireEvent.click(screen.getAllByRole('button', { name: '展开完整诊断' })[0]!);
    expect(screen.getByRole('dialog', { name: '总结失败诊断' }).textContent)
      .toContain('diagnostic tail');
  });

  it('uses natural copy when diagnostics cannot be read', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        summarizerLastErrors: vi.fn().mockRejectedValue(new Error('offline')),
      },
    });
    render(<SummarizerErrorsDiagnostic />);
    expect(await screen.findByText('读取诊断列表失败，请稍后重试。')).toBeTruthy();
    expect(document.body.textContent).not.toContain('offline');
    expect(document.body.textContent).not.toContain('拉取失败');
  });
});
