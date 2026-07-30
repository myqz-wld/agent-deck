// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { SummarizerErrorsDiagnostic } from '../SummarizerErrorsDiagnostic';

afterEach(() => cleanup());

describe('SummarizerErrorsDiagnostic', () => {
  it('keeps the original bounded inline diagnostic list without a magnify entry', async () => {
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
      expect(screen.getAllByRole('listitem')).toHaveLength(5);
    });
    expect(document.body.textContent).not.toContain('diagnostic tail');
    expect(screen.queryByRole('button', { name: '展开完整诊断' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
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
