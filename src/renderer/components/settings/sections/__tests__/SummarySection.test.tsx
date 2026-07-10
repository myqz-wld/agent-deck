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
  it('enables provider-valid choices and coerces both summary and hand-off values', async () => {
    const onPatch = vi.fn();
    render(
      <SettingsHarness
        initial={{
          ...DEFAULT_SETTINGS,
          summaryProvider: 'codex',
          summaryReasoning: 'minimal',
          handOffProvider: 'codex',
          handOffReasoning: 'ultra',
        }}
        onPatch={onPatch}
      />,
    );
    openSection();

    let summaryButtons = rowButtons('周期性总结');
    expect(summaryButtons[1]?.title).toBe('Codex 思考程度');
    fireEvent.click(summaryButtons[1]!);
    expect(visibleOptionLabels()).toEqual([
      'MINIMAL',
      'LOW',
      'MEDIUM',
      'HIGH',
      'XHIGH',
      'ULTRA',
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'MINIMAL' }));

    summaryButtons = rowButtons('周期性总结');
    fireEvent.click(summaryButtons[0]!);
    fireEvent.click(screen.getByRole('option', { name: 'Claude' }));

    await waitFor(() => {
      const reasoningButton = rowButtons('周期性总结')[1]!;
      expect(reasoningButton.title).toBe('Claude 思考程度');
      expect(reasoningButton.textContent).toContain('LOW');
      expect(reasoningButton.disabled).toBe(false);
    });
    expect(onPatch).toHaveBeenCalledWith({
      summaryProvider: 'claude',
      summaryReasoning: 'low',
    });

    fireEvent.click(rowButtons('周期性总结')[1]!);
    expect(visibleOptionLabels()).toEqual(['LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAX']);
    fireEvent.click(screen.getByRole('option', { name: 'LOW' }));

    let handOffButtons = rowButtons('Hand-off 简报');
    fireEvent.click(handOffButtons[0]!);
    fireEvent.click(screen.getByRole('option', { name: 'Deepseek' }));

    await waitFor(() => {
      const reasoningButton = rowButtons('Hand-off 简报')[1]!;
      expect(reasoningButton.title).toBe('Deepseek 思考程度');
      expect(reasoningButton.textContent).toContain('MAX');
      expect(reasoningButton.disabled).toBe(false);
    });
    expect(onPatch).toHaveBeenCalledWith({
      handOffProvider: 'deepseek',
      handOffReasoning: 'max',
    });

    handOffButtons = rowButtons('Hand-off 简报');
    fireEvent.click(handOffButtons[1]!);
    expect(visibleOptionLabels()).toEqual(['LOW', 'MEDIUM', 'HIGH', 'XHIGH', 'MAX']);
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

    fireEvent.click(rowButtons('周期性总结')[0]!);
    fireEvent.click(screen.getByRole('option', { name: 'Deepseek' }));

    await waitFor(() => {
      expect(rowButtons('周期性总结')[1]?.textContent).toContain('XHIGH');
    });
    expect(onPatch).toHaveBeenCalledWith({
      summaryProvider: 'deepseek',
      summaryReasoning: 'xhigh',
    });
  });

  it('coerces Claude MAX to XHIGH when switching the settings row to Codex', async () => {
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

    fireEvent.click(rowButtons('周期性总结')[0]!);
    fireEvent.click(screen.getByRole('option', { name: 'Codex' }));

    await waitFor(() => {
      expect(rowButtons('周期性总结')[1]?.textContent).toContain('XHIGH');
    });
    expect(onPatch).toHaveBeenCalledWith({
      summaryProvider: 'codex',
      summaryReasoning: 'xhigh',
    });
    fireEvent.click(rowButtons('周期性总结')[1]!);
    expect(visibleOptionLabels()).not.toContain('MAX');
  });
});
