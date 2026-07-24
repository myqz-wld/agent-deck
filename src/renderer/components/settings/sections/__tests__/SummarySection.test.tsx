// @vitest-environment happy-dom
import { useState, type JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types';
import { SummarySection } from '../SummarySection';

function SettingsHarness({
  initial,
  onPatch,
}: {
  initial: AppSettings;
  onPatch: (patch: Partial<AppSettings>) => void;
}): JSX.Element {
  const [settings, setSettings] = useState(initial);
  const update = async (patch: Partial<AppSettings>): Promise<void> => {
    onPatch(patch);
    setSettings((current) => ({ ...current, ...patch }));
  };

  return <SummarySection settings={settings} update={update} />;
}

function openSection(): void {
  const title = screen.getByText('间歇总结');
  const button = title.closest('button');
  if (!button) throw new Error('Summary section toggle was not rendered');
  fireEvent.click(button);
}

function visibleOptionLabels(): string[] {
  return screen.getAllByRole('option').map((option) => option.textContent ?? '');
}

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      summarizerLastErrors: vi.fn().mockResolvedValue({}),
      listClaudeGatewayProfiles: vi.fn().mockResolvedValue([]),
      listCodexModelProviders: vi.fn().mockResolvedValue([]),
    },
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  Reflect.deleteProperty(window, 'api');
});

describe('SummarySection provider-specific thinking levels', () => {
  it('enables provider-valid choices and coerces summary values', async () => {
    const onPatch = vi.fn();
    render(
      <SettingsHarness
        initial={{
          ...DEFAULT_SETTINGS,
          summaryAdapter: 'codex-cli',
          summaryThinking: 'low',
        }}
        onPatch={onPatch}
      />,
    );
    openSection();
    expect(screen.getByText('留空时使用所选 Codex provider 的默认模型。')).toBeTruthy();
    expect(
      (screen.getByRole('textbox', { name: '总结模型 model' }) as HTMLInputElement)
        .placeholder,
    ).toBe('模型（可留空）');

    let thinkingButton = screen.getByRole('button', { name: '总结模型 思考程度' });
    expect(thinkingButton.title).toBe('Codex CLI 思考程度');
    fireEvent.click(thinkingButton);
    expect(visibleOptionLabels()).toEqual([
      'LOW',
      'MEDIUM',
      'HIGH',
      'XHIGH',
      'MAX',
      'ULTRA',
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'LOW' }));

    fireEvent.click(screen.getByRole('button', { name: '总结模型 adapter' }));
    fireEvent.click(screen.getByRole('option', { name: 'Claude Code' }));

    await waitFor(() => {
      const reasoningButton = screen.getByRole('button', {
        name: '总结模型 思考程度',
      }) as HTMLButtonElement;
      expect(reasoningButton.title).toBe('Claude Code 思考程度');
      expect(reasoningButton.textContent).toContain('LOW');
      expect(reasoningButton.disabled).toBe(false);
      expect(
        (screen.getByRole('textbox', { name: '总结模型 model' }) as HTMLInputElement)
          .placeholder,
      ).toBe('模型（可留空）');
    });
    expect(screen.getByText('留空时使用 Claude Haiku。')).toBeTruthy();
    expect(onPatch).toHaveBeenCalledWith({
      summaryAdapter: 'claude-code',
      summaryRuntimeProvider: '',
      summaryModel: '',
      summaryThinking: 'low',
    });

    thinkingButton = screen.getByRole('button', { name: '总结模型 思考程度' });
    fireEvent.click(thinkingButton);
    expect(visibleOptionLabels()).toEqual(['LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAX']);
    fireEvent.click(screen.getByRole('option', { name: 'LOW' }));
    expect(screen.queryByText('Hand-off 简报')).toBeNull();
  });

  it('preserves a thinking level shared by Codex and Claude-family providers', async () => {
    const onPatch = vi.fn();
    render(
      <SettingsHarness
        initial={{
          ...DEFAULT_SETTINGS,
          summaryAdapter: 'codex-cli',
          summaryThinking: 'xhigh',
        }}
        onPatch={onPatch}
      />,
    );
    openSection();

    fireEvent.click(screen.getByRole('button', { name: '总结模型 adapter' }));
    fireEvent.click(screen.getByRole('option', { name: 'Claude Code' }));
    fireEvent.change(screen.getByRole('combobox', { name: '总结模型 Gateway' }), {
      target: { value: 'deepseek' },
    });

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '总结模型 思考程度' }).textContent,
      ).toContain('XHIGH');
      expect(
        (screen.getByRole('textbox', { name: '总结模型 model' }) as HTMLInputElement)
          .placeholder,
      ).toBe('模型（可留空）');
    });
    expect(
      screen.getByText('留空时使用 deepseek Gateway 的 Haiku 路由。'),
    ).toBeTruthy();
    expect(onPatch).toHaveBeenCalledWith({
      summaryRuntimeProvider: 'deepseek',
      summaryModel: '',
    });
  });

  it('coerces a legacy Codex minimal value to low when switching provider', async () => {
    const onPatch = vi.fn();
    render(
      <SettingsHarness
        initial={{
          ...DEFAULT_SETTINGS,
          summaryAdapter: 'codex-cli',
          summaryThinking: 'minimal',
        }}
        onPatch={onPatch}
      />,
    );
    openSection();

    fireEvent.click(screen.getByRole('button', { name: '总结模型 adapter' }));
    fireEvent.click(screen.getByRole('option', { name: 'Claude Code' }));

    await waitFor(() => {
      expect(onPatch).toHaveBeenCalledWith({
        summaryAdapter: 'claude-code',
        summaryRuntimeProvider: '',
        summaryModel: '',
        summaryThinking: 'low',
      });
    });
  });

  it('preserves Claude MAX when switching the settings row to Codex', async () => {
    const onPatch = vi.fn();
    render(
      <SettingsHarness
        initial={{
          ...DEFAULT_SETTINGS,
          summaryAdapter: 'claude-code',
          summaryThinking: 'max',
        }}
        onPatch={onPatch}
      />,
    );
    openSection();

    fireEvent.click(screen.getByRole('button', { name: '总结模型 adapter' }));
    fireEvent.click(screen.getByRole('option', { name: 'Codex CLI' }));

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '总结模型 思考程度' }).textContent,
      ).toContain('MAX');
    });
    expect(onPatch).toHaveBeenCalledWith({
      summaryAdapter: 'codex-cli',
      summaryRuntimeProvider: '',
      summaryModel: '',
      summaryThinking: 'max',
    });
    fireEvent.click(screen.getByRole('button', { name: '总结模型 思考程度' }));
    expect(visibleOptionLabels()).toContain('MAX');
  });

  it('offers Grok Build with its xhigh ceiling and config.toml model default', async () => {
    const onPatch = vi.fn();
    render(
      <SettingsHarness
        initial={{
          ...DEFAULT_SETTINGS,
          summaryAdapter: 'codex-cli',
          summaryThinking: 'ultra',
        }}
        onPatch={onPatch}
      />,
    );
    openSection();

    fireEvent.click(screen.getByRole('button', { name: '总结模型 adapter' }));
    fireEvent.click(screen.getByRole('option', { name: 'Grok Build' }));

    await waitFor(() => {
      const thinking = screen.getByRole('button', { name: '总结模型 思考程度' });
      expect(thinking.title).toBe('Grok Build 思考程度');
      expect(thinking.textContent).toContain('XHIGH');
      expect(screen.getByText('留空时使用 Grok 配置默认模型。')).toBeTruthy();
    });
    expect(onPatch).toHaveBeenCalledWith({
      summaryAdapter: 'grok-build',
      summaryRuntimeProvider: '',
      summaryModel: '',
      summaryThinking: 'xhigh',
    });
    fireEvent.click(screen.getByRole('button', { name: '总结模型 思考程度' }));
    expect(visibleOptionLabels()).toEqual(['LOW', 'MEDIUM', 'HIGH', 'XHIGH']);
  });

  it('trims a custom summary model before saving it', async () => {
    const onPatch = vi.fn();
    render(
      <SettingsHarness
        initial={{
          ...DEFAULT_SETTINGS,
          summaryAdapter: 'codex-cli',
        }}
        onPatch={onPatch}
      />,
    );
    openSection();

    const input = screen.getByRole('textbox', { name: '总结模型 model' });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '  gpt-5.6-sol  ' } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect((input as HTMLInputElement).value).toBe('gpt-5.6-sol');
    });
    expect(onPatch).toHaveBeenCalledWith({ summaryModel: 'gpt-5.6-sol' });
  });

  it('can disable periodic summaries before they start another model call', () => {
    const onPatch = vi.fn();
    render(<SettingsHarness initial={DEFAULT_SETTINGS} onPatch={onPatch} />);
    openSection();

    expect(
      screen.getByText('用于会话卡片和「总结」视图，不用于会话接力或历史恢复。'),
    ).toBeTruthy();
    expect(screen.getByText('关闭后不再生成新总结。')).toBeTruthy();
    expect(
      (screen.getByRole('textbox', { name: '每多少个事件总结' }) as HTMLInputElement).value,
    ).toBe('30');
    const toggle = screen.getByRole('checkbox', { name: '启用周期总结' });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    expect(onPatch).toHaveBeenCalledWith({ summaryEnabled: false });
  });

  it('updates the concurrent summary limit within the supported range', async () => {
    const onPatch = vi.fn();
    render(<SettingsHarness initial={DEFAULT_SETTINGS} onPatch={onPatch} />);
    openSection();

    const input = screen.getByRole('textbox', { name: '最多同时总结的会话数' });
    expect((input as HTMLInputElement).value).toBe('2');
    expect(input.getAttribute('min')).toBe('1');
    expect(input.getAttribute('max')).toBe('10');
    expect(screen.getByText('限制后台总结模型的并发调用数。')).toBeTruthy();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.blur(input);
    await waitFor(() => expect(onPatch).toHaveBeenCalledWith({ summaryMaxConcurrent: 4 }));
  });
});
