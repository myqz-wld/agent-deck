// @vitest-environment happy-dom
import { useState, type JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types';
import { ContinuationContextSection } from '../ContinuationContextSection';

function SettingsHarness({
  initial,
  onPatch,
  readOnly = false,
}: {
  initial: AppSettings;
  onPatch: (patch: Partial<AppSettings>) => void;
  readOnly?: boolean;
}): JSX.Element {
  const [settings, setSettings] = useState(initial);
  const update = async (patch: Partial<AppSettings>): Promise<void> => {
    onPatch(patch);
    setSettings((current) => ({ ...current, ...patch }));
  };

  return <ContinuationContextSection settings={settings} update={update} readOnly={readOnly} />;
}

function openSection(): void {
  const title = screen.getByText('会话续接上下文');
  const button = title.closest('button');
  if (!button) throw new Error('Continuation context section toggle was not rendered');
  fireEvent.click(button);
}

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      listClaudeGatewayProfiles: vi.fn().mockResolvedValue([{ id: 'deepseek' }]),
      listCodexGatewayProfiles: vi.fn().mockResolvedValue([]),
    },
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  Reflect.deleteProperty(window, 'api');
});

describe('ContinuationContextSection', () => {
  it('shows the generator boundary and provider-specific thinking levels', async () => {
    const onPatch = vi.fn();
    render(
      <SettingsHarness
        initial={{
          ...DEFAULT_SETTINGS,
          continuationCheckpointAdapter: 'codex-cli',
          continuationCheckpointThinking: 'ultra',
        }}
        onPatch={onPatch}
      />,
    );
    openSection();

    expect(
      screen.getByText(
        /达到检查间隔.*32,000 token.*会话空闲.*48,000 token.*不会中断当前回复/,
      ),
    ).not.toBeNull();
    expect(
      screen.getByText('留空时使用所选 Codex 模型网关的默认模型。'),
    ).not.toBeNull();
    expect(
      (screen.getByRole('textbox', { name: '上下文整理模型 模型' }) as HTMLInputElement)
        .placeholder,
    ).toBe('留空使用默认模型');

    fireEvent.click(screen.getByRole('button', { name: '上下文整理模型 思考程度' }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'LOW',
      'MEDIUM',
      'HIGH',
      'XHIGH',
      'MAX',
      'ULTRA',
    ]);
    fireEvent.click(screen.getByRole('option', { name: 'ULTRA' }));

    fireEvent.click(screen.getByRole('button', { name: '上下文整理模型 助手' }));
    fireEvent.click(screen.getByRole('option', { name: 'Claude Code' }));

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '上下文整理模型 思考程度' }).textContent,
      ).toContain('MAX');
      expect(
        (screen.getByRole('textbox', {
          name: '上下文整理模型 模型',
        }) as HTMLInputElement).placeholder,
      ).toBe('留空使用默认模型');
      expect(
        screen.getByText('留空时使用 Claude Code 的 Sonnet 模型。'),
      ).not.toBeNull();
    });
    expect(onPatch).toHaveBeenCalledWith({
      continuationCheckpointAdapter: 'claude-code',
      continuationCheckpointRuntimeProvider: '',
      continuationCheckpointModel: '',
      continuationCheckpointThinking: 'max',
    });

    fireEvent.click(screen.getByRole('button', { name: '上下文整理模型 思考程度' }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'LOW',
      'MEDIUM',
      'HIGH',
      'XHIGH',
      'MAX',
    ]);

    fireEvent.click(screen.getByRole('combobox', { name: '上下文整理模型 模型网关' }));
    fireEvent.click(screen.getByRole('option', { name: 'deepseek' }));
    await waitFor(() => {
      expect(
        (screen.getByRole('textbox', {
          name: '上下文整理模型 模型',
        }) as HTMLInputElement).placeholder,
      ).toBe('留空使用默认模型');
      expect(
        screen.getByText('留空时使用 deepseek 模型网关的 Sonnet 路由。'),
      ).not.toBeNull();
    });
    expect(onPatch).toHaveBeenCalledWith({
      continuationCheckpointRuntimeProvider: 'deepseek',
      continuationCheckpointModel: '',
    });
  });

  it('saves a trimmed model and clamps the token retention range', async () => {
    const onPatch = vi.fn();
    render(<SettingsHarness initial={DEFAULT_SETTINGS} onPatch={onPatch} />);
    openSection();

    const modelInput = screen.getByRole('textbox', { name: '上下文整理模型 模型' });
    fireEvent.focus(modelInput);
    fireEvent.change(modelInput, { target: { value: '  claude-sonnet-custom  ' } });
    fireEvent.blur(modelInput);
    expect(onPatch).toHaveBeenCalledWith({
      continuationCheckpointModel: 'claude-sonnet-custom',
    });

    const tokenInput = screen.getByRole('textbox', { name: '保留最近对话的 token 上限' });
    expect((tokenInput as HTMLInputElement).value).toBe('64000');
    expect(tokenInput.getAttribute('min')).toBe('8000');
    expect(tokenInput.getAttribute('max')).toBe('128000');
    expect(
      screen.getByText(
        '仅限制续接上下文中的最近用户输入，不包含检查点、当前指令和回复预留。',
      ),
    ).not.toBeNull();

    fireEvent.focus(tokenInput);
    fireEvent.change(tokenInput, { target: { value: '7999' } });
    fireEvent.blur(tokenInput);
    expect(onPatch).toHaveBeenCalledWith({ continuationRawRetentionTokens: 8000 });

    await waitFor(() => expect((tokenInput as HTMLInputElement).value).toBe('8000'));
    fireEvent.focus(tokenInput);
    fireEvent.change(tokenInput, { target: { value: '128001' } });
    fireEvent.blur(tokenInput);
    expect(onPatch).toHaveBeenCalledWith({ continuationRawRetentionTokens: 128000 });
  });

  it('offers Grok Build as a checkpoint generator with xhigh as its ceiling', async () => {
    const onPatch = vi.fn();
    render(
      <SettingsHarness
        initial={{
          ...DEFAULT_SETTINGS,
          continuationCheckpointAdapter: 'codex-cli',
          continuationCheckpointThinking: 'max',
        }}
        onPatch={onPatch}
      />,
    );
    openSection();

    fireEvent.click(screen.getByRole('button', { name: '上下文整理模型 助手' }));
    fireEvent.click(screen.getByRole('option', { name: 'Grok Build' }));

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '上下文整理模型 思考程度' }).textContent,
      ).toContain('XHIGH');
      expect(
        screen.getByText('留空时使用 Grok Build 配置中的默认模型。'),
      ).not.toBeNull();
    });
    expect(onPatch).toHaveBeenCalledWith({
      continuationCheckpointAdapter: 'grok-build',
      continuationCheckpointRuntimeProvider: '',
      continuationCheckpointModel: '',
      continuationCheckpointThinking: 'xhigh',
    });
    fireEvent.click(screen.getByRole('button', { name: '上下文整理模型 思考程度' }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'LOW',
      'MEDIUM',
      'HIGH',
      'XHIGH',
    ]);
  });

  it('toggles automatic checkpoint maintenance and clamps scheduling controls', async () => {
    const onPatch = vi.fn();
    render(<SettingsHarness initial={DEFAULT_SETTINGS} onPatch={onPatch} />);
    openSection();

    const toggle = screen.getByRole('checkbox', { name: '自动维护续接检查点' });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    expect(onPatch).toHaveBeenCalledWith({ continuationCheckpointAutoRefreshEnabled: false });

    const interval = screen.getByRole('textbox', { name: '常规检查间隔（分钟）' });
    expect((interval as HTMLInputElement).value).toBe('30');
    expect(interval.getAttribute('min')).toBe('5');
    expect(interval.getAttribute('max')).toBe('1440');

    fireEvent.focus(interval);
    fireEvent.change(interval, { target: { value: '4' } });
    fireEvent.blur(interval);
    expect(onPatch).toHaveBeenCalledWith({
      continuationCheckpointAutoRefreshIntervalMinutes: 5,
    });

    await waitFor(() => expect((interval as HTMLInputElement).value).toBe('5'));
    fireEvent.focus(interval);
    fireEvent.change(interval, { target: { value: '1441' } });
    fireEvent.blur(interval);
    expect(onPatch).toHaveBeenCalledWith({
      continuationCheckpointAutoRefreshIntervalMinutes: 1440,
    });

    const concurrency = screen.getByRole('textbox', {
      name: '最多同时整理的会话数',
    });
    expect((concurrency as HTMLInputElement).value).toBe('2');
    expect(concurrency.getAttribute('min')).toBe('1');
    expect(concurrency.getAttribute('max')).toBe('10');
    expect(screen.getByText('限制后台上下文整理模型的并发调用数。')).not.toBeNull();

    fireEvent.focus(concurrency);
    fireEvent.change(concurrency, { target: { value: '0' } });
    fireEvent.blur(concurrency);
    expect(onPatch).toHaveBeenCalledWith({ continuationCheckpointMaxConcurrent: 1 });

    await waitFor(() => expect((concurrency as HTMLInputElement).value).toBe('1'));
    fireEvent.focus(concurrency);
    fireEvent.change(concurrency, { target: { value: '11' } });
    fireEvent.blur(concurrency);
    expect(onPatch).toHaveBeenCalledWith({ continuationCheckpointMaxConcurrent: 10 });
  });

  it('uses the shared trigger, model, concurrency, feature-specific field order', () => {
    render(<SettingsHarness initial={DEFAULT_SETTINGS} onPatch={vi.fn()} />);
    openSection();

    const section = screen.getByText('会话续接上下文').closest('section');
    expect(section).not.toBeNull();
    expect(Array.from(section!.querySelectorAll<HTMLElement>('[data-settings-field]'))
      .map((field) => field.dataset.settingsField))
      .toEqual([
        '自动维护续接检查点',
        '常规检查间隔（分钟）',
        '上下文整理模型',
        '最多同时整理的会话数',
        '保留最近对话的 token 上限',
      ]);
  });

  it('keeps all four Remote generator fields in the same disabled layout', () => {
    render(
      <SettingsHarness
        initial={{ ...DEFAULT_SETTINGS, continuationCheckpointAdapter: 'codex-cli' }}
        onPatch={vi.fn()}
        readOnly
      />,
    );
    openSection();

    const group = screen.getByRole('group', { name: '上下文整理模型' });
    expect(Array.from(group.querySelectorAll<HTMLElement>('[data-generator-field]'))
      .map((field) => field.dataset.generatorField))
      .toEqual(['adapter', 'provider', 'model', 'thinking']);
    expect((screen.getByRole('button', {
      name: '上下文整理模型 助手',
    }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('combobox', {
      name: '上下文整理模型 模型网关',
    }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('textbox', {
      name: '上下文整理模型 模型',
    }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', {
      name: '上下文整理模型 思考程度',
    }) as HTMLButtonElement).disabled).toBe(true);
  });
});
