// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { AssetMeta } from '@shared/types';
import { BundledAgentRuntimeEditor } from './BundledAgentRuntimeEditor';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

function codexAsset(overrides: Partial<AssetMeta> = {}): AssetMeta {
  return {
    kind: 'agent',
    source: 'bundled',
    adapter: 'codex-cli',
    name: 'reviewer-codex',
    qualifiedName: 'agent-deck:codex-cli:reviewer-codex',
    description: 'reviewer',
    model: 'gpt-5.6-sol',
    thinking: 'xhigh',
    absPath: '/plugin/reviewer-codex.toml',
    bundledAgentRuntime: {
      defaults: { model: 'gpt-5.6-sol', thinking: 'xhigh' },
      override: {},
    },
    ...overrides,
  };
}

describe('BundledAgentRuntimeEditor', () => {
  it('offers xhigh for Grok Build built-in Agents', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        saveBundledAgentRuntime: vi.fn(),
        resetBundledAgentRuntime: vi.fn(),
        confirmDialog: vi.fn(),
      },
    });
    render(
      <BundledAgentRuntimeEditor
        asset={{
          ...codexAsset(),
          adapter: 'grok-build',
          name: 'reviewer-grok',
          qualifiedName: 'agent-deck:grok-build:reviewer-grok',
          model: 'grok-4.5',
          thinking: 'high',
          bundledAgentRuntime: {
            defaults: { model: 'grok-4.5', thinking: 'high' },
            override: {},
          },
        }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '思考等级' }));
    expect(screen.getByRole('option', { name: 'xhigh' })).toBeTruthy();
  });

  it('saves only runtime deltas and keeps Codex provider definitions native', async () => {
    const saveBundledAgentRuntime = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listCodexModelProviders: vi.fn().mockResolvedValue([
          {
            id: 'fable',
            name: 'Fable Gateway',
            configuredAsTopLevelDefault: false,
          },
        ]),
        saveBundledAgentRuntime,
        resetBundledAgentRuntime: vi.fn(),
        confirmDialog: vi.fn(),
      },
    });
    const onSaved = vi.fn();
    render(
      <BundledAgentRuntimeEditor
        asset={codexAsset()}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );

    fireEvent.change(screen.getByLabelText('模型'), {
      target: { value: 'qw-pro-5' },
    });
    fireEvent.click(screen.getByRole('button', { name: '思考等级' }));
    fireEvent.click(screen.getByRole('option', { name: 'high' }));
    fireEvent.change(screen.getByLabelText('provider'), {
      target: { value: 'fable' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(saveBundledAgentRuntime).toHaveBeenCalledWith(
        'codex-cli',
        'reviewer-codex',
        { model: 'qw-pro-5', thinking: 'high', provider: 'fable' },
      ),
    );
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByText(/不会修改 packaged 资产、用户 Agent 或原生配置。/),
    ).toBeTruthy();
  });

  it('reset deletes the whole built-in override record', async () => {
    const resetBundledAgentRuntime = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listCodexModelProviders: vi.fn().mockResolvedValue([]),
        saveBundledAgentRuntime: vi.fn(),
        resetBundledAgentRuntime,
        confirmDialog: vi.fn(),
      },
    });
    render(
      <BundledAgentRuntimeEditor
        asset={codexAsset({
          model: 'qw-pro-5',
          provider: 'fable',
          bundledAgentRuntime: {
            defaults: { model: 'gpt-5.6-sol', thinking: 'xhigh' },
            override: { model: 'qw-pro-5', provider: 'fable' },
          },
        })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    await waitFor(() =>
      expect(resetBundledAgentRuntime).toHaveBeenCalledWith(
        'codex-cli',
        'reviewer-codex',
      ),
    );
  });

  it('requires restore-default instead of saving an empty packaged provider', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        listCodexModelProviders: vi.fn().mockResolvedValue([]),
        saveBundledAgentRuntime: vi.fn(),
        resetBundledAgentRuntime: vi.fn(),
        confirmDialog: vi.fn(),
      },
    });
    render(
      <BundledAgentRuntimeEditor
        asset={codexAsset({
          provider: 'fable',
          bundledAgentRuntime: {
            defaults: {
              model: 'gpt-5.6-sol',
              thinking: 'xhigh',
              provider: 'openai',
            },
            override: { provider: 'fable' },
          },
        })}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText('provider'), {
      target: { value: '' },
    });

    expect(
      screen.getByText('内建默认 provider 不能为空；如需撤销自定义值，请恢复默认'),
    ).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
