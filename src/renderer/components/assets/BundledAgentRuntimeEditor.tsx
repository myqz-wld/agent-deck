import { useEffect, useRef, useState, type JSX } from 'react';
import {
  ASSET_LIMITS,
  type AssetMeta,
  type BundledAgentRuntimeOverride,
  type CodexModelProviderOption,
} from '@shared/types';
import { CloseIcon, RefreshIcon, SaveIcon } from '../icons';

interface Props {
  asset: AssetMeta;
  onClose: () => void;
  onSaved: () => void;
}

const THINKING_LEVELS = {
  'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
  'codex-cli': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'grok-build': ['low', 'medium', 'high'],
} as const;

export function BundledAgentRuntimeEditor({
  asset,
  onClose,
  onSaved,
}: Props): JSX.Element {
  const runtime = asset.bundledAgentRuntime ?? { defaults: {}, override: {} };
  const defaults = runtime.defaults;
  const [model, setModel] = useState(asset.model ?? '');
  const [thinking, setThinking] = useState(asset.thinking ?? '');
  const [provider, setProvider] = useState(asset.provider ?? '');
  const [providers, setProviders] = useState<CodexModelProviderOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (asset.adapter !== 'codex-cli') return;
    let cancelled = false;
    void window.api
      .listCodexModelProviders()
      .then((items) => {
        if (!cancelled) setProviders(items);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(`Codex provider 读取失败：${reason instanceof Error ? reason.message : String(reason)}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [asset.adapter]);

  const normalizedModel = model.trim();
  const normalizedThinking = thinking.trim();
  const normalizedProvider = provider.trim();
  const dirty =
    normalizedModel !== (asset.model ?? '') ||
    normalizedThinking !== (asset.thinking ?? '') ||
    normalizedProvider !== (asset.provider ?? '');
  const modelError =
    normalizedModel.length > ASSET_LIMITS.runtimeModel
      ? `模型名太长（最多 ${ASSET_LIMITS.runtimeModel} 字）`
      : defaults.model && !normalizedModel
        ? '内建默认模型不能为空；如需撤销自定义值，请恢复默认'
        : invalidSingleLine(normalizedModel)
          ? '模型名必须是单行可打印文本'
          : null;
  const providerError =
    normalizedProvider.length > ASSET_LIMITS.provider
      ? `provider 太长（最多 ${ASSET_LIMITS.provider} 字）`
      : defaults.provider && !normalizedProvider
        ? '内建默认 provider 不能为空；如需撤销自定义值，请恢复默认'
        : invalidSingleLine(normalizedProvider)
          ? 'provider 必须是单行可打印文本'
          : null;
  const hasError = Boolean(modelError || providerError);
  const hasOverride = Object.keys(runtime.override).length > 0;

  const save = async (): Promise<void> => {
    if (!dirty || hasError) return;
    const override: BundledAgentRuntimeOverride = {};
    if (normalizedModel && normalizedModel !== defaults.model) override.model = normalizedModel;
    if (normalizedThinking && normalizedThinking !== defaults.thinking) {
      override.thinking = normalizedThinking;
    }
    if (
      asset.adapter === 'codex-cli' &&
      normalizedProvider &&
      normalizedProvider !== defaults.provider
    ) {
      override.provider = normalizedProvider;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await window.api.saveBundledAgentRuntime(
        asset.adapter,
        asset.name,
        override,
      );
      if (!result.ok) {
        if (mountedRef.current) setError(`保存失败：${result.reason ?? '未知错误'}`);
        return;
      }
      onSaved();
      onClose();
    } catch (reason) {
      if (mountedRef.current) {
        setError(`保存失败：${reason instanceof Error ? reason.message : String(reason)}`);
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const reset = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.api.resetBundledAgentRuntime(asset.adapter, asset.name);
      if (!result.ok) {
        if (mountedRef.current) setError(`恢复失败：${result.reason ?? '未知错误'}`);
        return;
      }
      onSaved();
      onClose();
    } catch (reason) {
      if (mountedRef.current) {
        setError(`恢复失败：${reason instanceof Error ? reason.message : String(reason)}`);
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const handleClose = async (): Promise<void> => {
    if (!dirty) {
      onClose();
      return;
    }
    const discard = await window.api.confirmDialog({
      title: '关闭运行配置',
      message: '有未保存改动，确定要丢弃吗？',
      okLabel: '丢弃并关闭',
      cancelLabel: '继续编辑',
      destructive: true,
    });
    if (discard) onClose();
  };

  const providerListId = `codex-model-providers-${asset.name}`;
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="no-drag flex w-[400px] flex-col rounded-xl border border-deck-border bg-deck-bg-strong p-4 shadow-2xl">
        <header className="mb-3 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-[13px] font-medium">内建 Agent 运行配置</h3>
            <code className="text-[9px] text-deck-muted/60">{asset.qualifiedName}</code>
          </div>
          <button
            type="button"
            onClick={() => void handleClose()}
            aria-label="关闭运行配置"
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-deck-muted hover:bg-white/10"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </header>

        {error && (
          <div className="mb-2 rounded border border-status-waiting/40 bg-status-waiting/10 p-2 text-[10px] text-status-waiting">
            {error}
          </div>
        )}

        <div className="flex flex-col gap-3">
          <RuntimeField label="模型" error={modelError}>
            <input
              aria-label="模型"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={busy}
              placeholder="输入 adapter 原生模型名或别名"
              className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20 disabled:opacity-50"
            />
            <DefaultHint value={defaults.model} fallback="跟随 adapter 原生默认" />
          </RuntimeField>

          <RuntimeField label="思考等级">
            <select
              aria-label="思考等级"
              value={thinking}
              onChange={(event) => setThinking(event.target.value)}
              disabled={busy}
              className="w-full rounded border border-deck-border bg-deck-bg-strong px-2 py-1 text-[11px] outline-none focus:border-white/20 disabled:opacity-50"
            >
              {!defaults.thinking && <option value="">跟随 adapter 原生默认</option>}
              {THINKING_LEVELS[asset.adapter].map((level) => (
                <option key={level} value={level}>{level}</option>
              ))}
            </select>
            <DefaultHint value={defaults.thinking} fallback="跟随 adapter 原生默认" />
          </RuntimeField>

          {asset.adapter === 'codex-cli' && (
            <RuntimeField label="provider" error={providerError}>
              <input
                aria-label="provider"
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
                disabled={busy}
                list={providerListId}
                placeholder="留空则跟随 Codex 原生配置"
                className="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20 disabled:opacity-50"
              />
              <datalist id={providerListId}>
                {providers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name ?? item.id}
                  </option>
                ))}
              </datalist>
              <DefaultHint value={defaults.provider} fallback="跟随 ~/.codex/config.toml" />
            </RuntimeField>
          )}

          <div className="rounded border border-deck-border/70 bg-white/[0.025] p-2 text-[10px] leading-relaxed text-deck-muted/75">
            {nativeConfigHint(asset.adapter)}
            {' '}这里只保存内建 Agent 的运行时差异；不会修改 packaged 资产、用户 Agent 或原生配置。
          </div>
        </div>

        <footer className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[10px] text-deck-muted/60">
            {hasOverride ? '当前有自定义运行配置' : '当前使用内建默认值'}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void reset()}
              disabled={busy || !hasOverride}
              className="rounded bg-white/8 px-2 py-1 text-[10px] text-deck-muted hover:bg-white/15 disabled:opacity-35"
            >
              <RefreshIcon className="mr-1 inline h-3 w-3" />恢复默认
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy || !dirty || hasError}
              className="rounded bg-status-working/20 px-3 py-1 text-[10px] text-status-working hover:bg-status-working/30 disabled:opacity-40"
            >
              <SaveIcon className="mr-1 inline h-3 w-3" />保存
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function RuntimeField({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | null;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-[11px]">
      <span className="text-[10px] uppercase tracking-wider text-deck-muted/70">{label}</span>
      {children}
      {error && <span className="text-[10px] text-status-waiting">{error}</span>}
    </label>
  );
}

function DefaultHint({ value, fallback }: { value?: string; fallback: string }): JSX.Element {
  return (
    <span className="text-[9px] text-deck-muted/55">
      内建默认：<code>{value || fallback}</code>
    </span>
  );
}

function invalidSingleLine(value: string): boolean {
  return /[\r\n\u0000-\u001f\u007f]/.test(value);
}

function nativeConfigHint(adapter: AssetMeta['adapter']): string {
  if (adapter === 'codex-cli') {
    return 'provider 定义仍由 ~/.codex/config.toml 的 [model_providers.<id>] 管理。';
  }
  if (adapter === 'grok-build') {
    return '自定义模型别名仍由 ~/.grok/config.toml 的 [model.<alias>] 管理。';
  }
  return 'Claude Code / Deepseek 的 endpoint、鉴权和模型路由仍由各自的原生配置管理。';
}
