// @vitest-environment happy-dom
import { useState, type JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

function rowButtons(label: string): HTMLButtonElement[] {
  const row = screen.getByText(label).parentElement;
  if (!row) throw new Error(`${label} row was not rendered`);
  return within(row).getAllByRole('button') as HTMLButtonElement[];
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
          summaryProvider: 'codex',
          summaryReasoning: 'low',
        }}
        onPatch={onPatch}
      />,
    );
    openSection();
    expect(
      screen.getByText(
        /留空时使用 Codex 配置默认模型，思考程度默认 low。.*临时环境.*暂时无法验证模型内置工具是否为空/,
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole('textbox', { name: '总结模型 model' }) as HTMLInputElement)
        .placeholder,
    ).toBe('留空使用 Codex 配置默认模型');

    let summaryButtons = rowButtons('总结模型');
    expect(summaryButtons[1]?.title).toBe('Codex 思考程度');
    fireEvent.click(summaryButtons[1]!);
    expect(visibleOptionLabels()).toEqual([
      'LOW',
      'MEDIUM',
      'HIGH',
      'XHIGH',
      'MAX',
      'ULTRA',
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'LOW' }));

    summaryButtons = rowButtons('总结模型');
    fireEvent.click(summaryButtons[0]!);
    fireEvent.click(screen.getByRole('option', { name: 'Claude' }));

    await waitFor(() => {
      const reasoningButton = rowButtons('总结模型')[1]!;
      expect(reasoningButton.title).toBe('Claude 思考程度');
      expect(reasoningButton.textContent).toContain('LOW');
      expect(reasoningButton.disabled).toBe(false);
      expect(
        (screen.getByRole('textbox', { name: '总结模型 model' }) as HTMLInputElement)
          .placeholder,
      ).toBe('留空使用 Claude Haiku');
    });
    expect(
      screen.getByText('模型留空时使用 Claude Haiku，默认思考程度为 low。'),
    ).toBeTruthy();
    expect(onPatch).toHaveBeenCalledWith({
      summaryProvider: 'claude',
      summaryReasoning: 'low',
    });

    fireEvent.click(rowButtons('总结模型')[1]!);
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
          summaryProvider: 'codex',
          summaryReasoning: 'xhigh',
        }}
        onPatch={onPatch}
      />,
    );
    openSection();

    fireEvent.click(rowButtons('总结模型')[0]!);
    fireEvent.click(screen.getByRole('option', { name: 'Deepseek' }));

    await waitFor(() => {
      expect(rowButtons('总结模型')[1]?.textContent).toContain('XHIGH');
      expect(
        (screen.getByRole('textbox', { name: '总结模型 model' }) as HTMLInputElement)
          .placeholder,
      ).toBe('留空使用 Deepseek Sonnet');
    });
    expect(
      screen.getByText('模型留空时使用 Deepseek Sonnet，默认思考程度为 low。'),
    ).toBeTruthy();
    expect(onPatch).toHaveBeenCalledWith({
      summaryProvider: 'deepseek',
      summaryReasoning: 'xhigh',
    });
  });

  it('coerces a legacy Codex minimal value to low when switching provider', async () => {
    const onPatch = vi.fn();
    render(
      <SettingsHarness
        initial={{
          ...DEFAULT_SETTINGS,
          summaryProvider: 'codex',
          summaryReasoning: 'minimal',
        }}
        onPatch={onPatch}
      />,
    );
    openSection();

    fireEvent.click(rowButtons('总结模型')[0]!);
    fireEvent.click(screen.getByRole('option', { name: 'Claude' }));

    await waitFor(() => {
      expect(onPatch).toHaveBeenCalledWith({
        summaryProvider: 'claude',
        summaryReasoning: 'low',
      });
    });
  });

  it('preserves Claude MAX when switching the settings row to Codex', async () => {
    const onPatch = vi.fn();
    render(
      <SettingsHarness
        initial={{
          ...DEFAULT_SETTINGS,
          summaryProvider: 'claude',
          summaryReasoning: 'max',
        }}
        onPatch={onPatch}
      />,
    );
    openSection();

    fireEvent.click(rowButtons('总结模型')[0]!);
    fireEvent.click(screen.getByRole('option', { name: 'Codex' }));

    await waitFor(() => {
      expect(rowButtons('总结模型')[1]?.textContent).toContain('MAX');
    });
    expect(onPatch).toHaveBeenCalledWith({
      summaryProvider: 'codex',
      summaryReasoning: 'max',
    });
    fireEvent.click(rowButtons('总结模型')[1]!);
    expect(visibleOptionLabels()).toContain('MAX');
  });

  it('trims a custom summary model before saving it', async () => {
    const onPatch = vi.fn();
    render(
      <SettingsHarness
        initial={{
          ...DEFAULT_SETTINGS,
          summaryProvider: 'codex',
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

    expect(screen.getByText('关闭后不会启动新的总结模型调用。')).toBeTruthy();
    const toggle = screen.getByRole('checkbox', { name: '启用周期总结' });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    expect(onPatch).toHaveBeenCalledWith({ summaryEnabled: false });
  });
});
