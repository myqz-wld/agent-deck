// @vitest-environment happy-dom
import { useState, type JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types';
import { ContinuationContextSection } from '../ContinuationContextSection';

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

  return <ContinuationContextSection settings={settings} update={update} />;
}

function openSection(): void {
  const title = screen.getByText('会话续接上下文');
  const button = title.closest('button');
  if (!button) throw new Error('Continuation context section toggle was not rendered');
  fireEvent.click(button);
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('ContinuationContextSection', () => {
  it('shows the generator boundary and provider-specific thinking levels', async () => {
    const onPatch = vi.fn();
    render(
      <SettingsHarness
        initial={{
          ...DEFAULT_SETTINGS,
          continuationCheckpointProvider: 'codex',
          continuationCheckpointThinking: 'ultra',
        }}
        onPatch={onPatch}
      />,
    );
    openSection();

    expect(
      screen.getByText(
        '选择用于整理接力上下文的 provider 和模型；它可以不同于目标会话。模型留空时使用各 provider 的默认值。',
      ),
    ).not.toBeNull();
    expect(
      screen.getByText(
        '思考程度默认 high。在只读、无网络、无 MCP 的临时环境中运行；Codex app-server 暂时无法验证模型内置工具是否为空。可选 low、medium、high、xhigh、max、ultra。',
      ),
    ).not.toBeNull();
    expect(
      (screen.getByRole('textbox', { name: '上下文整理模型 model' }) as HTMLInputElement)
        .placeholder,
    ).toBe('留空使用 Codex 配置默认模型');

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

    fireEvent.click(screen.getByRole('button', { name: '上下文整理模型 provider' }));
    fireEvent.click(screen.getByRole('option', { name: 'Claude' }));

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: '上下文整理模型 思考程度' }).textContent,
      ).toContain('MAX');
      expect(
        (screen.getByRole('textbox', {
          name: '上下文整理模型 model',
        }) as HTMLInputElement).placeholder,
      ).toBe('留空使用 Claude Opus');
      expect(
        screen.getByText('默认思考程度为 high。Claude 与 Deepseek 支持 low 至 max。'),
      ).not.toBeNull();
    });
    expect(onPatch).toHaveBeenCalledWith({
      continuationCheckpointProvider: 'claude',
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

    fireEvent.click(screen.getByRole('button', { name: '上下文整理模型 provider' }));
    fireEvent.click(screen.getByRole('option', { name: 'Deepseek' }));
    await waitFor(() => {
      expect(
        (screen.getByRole('textbox', {
          name: '上下文整理模型 model',
        }) as HTMLInputElement).placeholder,
      ).toBe('留空使用 Deepseek Sonnet');
    });
  });

  it('saves a trimmed model and clamps the token retention range', async () => {
    const onPatch = vi.fn();
    render(<SettingsHarness initial={DEFAULT_SETTINGS} onPatch={onPatch} />);
    openSection();

    const modelInput = screen.getByRole('textbox', { name: '上下文整理模型 model' });
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
    expect(screen.getByText('按 token 计算，可设置 8,000–128,000；默认 64,000。')).not.toBeNull();

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
});
