// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_SETTINGS } from '@shared/types';
import { LogsSection } from '../LogsSection';

vi.mock('../LogViewerModal', () => ({
  LogViewerModal: () => null,
}));

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
  window.localStorage.clear();
});

function renderSection(api: {
  logsOpenDirectory: ReturnType<typeof vi.fn>;
  logsTruncateToday: ReturnType<typeof vi.fn>;
}, update = vi.fn()): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: api,
  });
  render(<LogsSection settings={DEFAULT_SETTINGS} update={update} />);
  fireEvent.click(screen.getByRole('button', { name: '日志' }));
}

describe('LogsSection', () => {
  it('uses the directory action without duplicating platform log paths', () => {
    renderSection({
      logsOpenDirectory: vi.fn(),
      logsTruncateToday: vi.fn(),
    });

    expect(screen.getByRole('button', { name: /打开日志目录/ })).toBeTruthy();
    expect(screen.getByText('按天分文件，保留 14 天。')).toBeTruthy();
    expect(screen.queryByText(/Library\/Logs\/Agent Deck/)).toBeNull();
    expect(screen.queryByText(/APPDATA.*Agent Deck.*logs/)).toBeNull();
    expect(screen.queryByText(/\.config\/Agent Deck\/logs/)).toBeNull();
  });

  it('shows a concise local error when opening the directory rejects', async () => {
    renderSection({
      logsOpenDirectory: vi.fn().mockRejectedValue(new Error('transport detail must stay local')),
      logsTruncateToday: vi.fn(),
    });

    fireEvent.click(screen.getByRole('button', { name: /打开日志目录/ }));

    await waitFor(() => {
      expect(screen.getByText('打开日志目录失败，请重试。')).toBeTruthy();
    });
    expect(screen.queryByText(/transport detail/)).toBeNull();
  });

  it('shows a concise local error when truncating rejects', async () => {
    renderSection({
      logsOpenDirectory: vi.fn(),
      logsTruncateToday: vi.fn().mockRejectedValue(new Error('transport detail must stay local')),
    });

    fireEvent.click(screen.getByRole('button', { name: /清空今天日志/ }));

    await waitFor(() => {
      expect(screen.getByText('清空今天日志失败，请重试。')).toBeTruthy();
    });
    expect(screen.queryByText(/transport detail/)).toBeNull();
  });

  it('shows a concise local error when the log-level update rejects', async () => {
    const update = vi.fn().mockRejectedValue(new Error('settings transport detail'));
    renderSection({
      logsOpenDirectory: vi.fn(),
      logsTruncateToday: vi.fn(),
    }, update);

    fireEvent.click(screen.getByRole('button', { name: 'INFO（默认）' }));
    fireEvent.click(screen.getByRole('option', { name: /DEBUG/ }));

    await waitFor(() => {
      expect(screen.getByText('更新日志级别失败，请重试。')).toBeTruthy();
    });
    expect(screen.queryByText(/settings transport detail/)).toBeNull();
  });
});
