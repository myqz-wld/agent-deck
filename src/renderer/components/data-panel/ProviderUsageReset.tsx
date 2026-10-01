import { useEffect, useRef, type JSX } from 'react';
import type { ProviderUsageResetRequest, ProviderUsageResetResult, ProviderUsageSnapshot } from '@shared/types';
import { confirmDialog } from '@renderer/lib/confirm-dialog';
import { EMPTY_USAGE_RESET, updateUsageReset, useUsageResetStore } from '@renderer/stores/usage-reset-store';
import { RefreshIcon } from '../icons';

export type ConsumeProviderReset = (request: ProviderUsageResetRequest) => Promise<ProviderUsageResetResult>;

export function ProviderUsageReset({
  snapshot, sourceKey, consume, disabled = false,
}: {
  snapshot: ProviderUsageSnapshot;
  sourceKey: string;
  consume?: ConsumeProviderReset;
  disabled?: boolean;
}): JSX.Element | null {
  const credit = snapshot.resetCredits;
  const accountId = credit?.accountId;
  const key = JSON.stringify([sourceKey, snapshot.provider, accountId]);
  const state = useUsageResetStore((store) => store.entries[key] ?? EMPTY_USAGE_RESET);
  const lifetime = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => { controller.abort(); };
  }, [key]);
  if (snapshot.provider !== 'codex-cli' || !credit) return null;

  const count = credit.availableCount;
  const available = count !== null && count > 0 && !!accountId && !!consume;
  const useReset = async (): Promise<void> => {
    if (disabled || !available || !consume || !accountId || count === null) return;
    if ((useUsageResetStore.getState().entries[key] ?? EMPTY_USAGE_RESET).phase !== 'idle') return;
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    updateUsageReset(key, { phase: 'confirming', error: null, message: null });
    try {
      const previous = useUsageResetStore.getState().entries[key]?.idempotencyKey;
      const confirmed = await confirmDialog({
        title: previous ? '重试本次 Codex 额度重置？' : '重置 Codex CLI 额度？',
        message: previous
          ? '将重试上一次操作，同一次重置不会重复扣除次数。'
          : `使用 1 次重置后将剩余 ${count - 1} 次。`,
        okLabel: previous ? '重试本次' : '确认重置',
        signal,
      });
      if (!confirmed || signal.aborted) return;
      const idempotencyKey = previous ?? crypto.randomUUID();
      updateUsageReset(key, { phase: 'running', idempotencyKey });
      const result = await consume({ provider: 'codex-cli', accountId, idempotencyKey });
      const message = result.outcome === 'nothingToReset'
        ? '当前没有需要重置的额度'
        : result.outcome === 'noCredit'
          ? '当前没有可用的重置次数'
          : '额度已重置';
      updateUsageReset(key, { idempotencyKey: null, error: null, message });
    } catch {
      updateUsageReset(key, { error: '重置结果尚未确认，可重试本次操作或刷新额度。' });
    } finally {
      updateUsageReset(key, { phase: 'idle' });
    }
  };

  return <div className="mt-1.5 border-t border-white/[0.06] pt-1.5 text-[10px]">
    <div className="flex min-h-5 items-center gap-2">
      <span className="text-deck-muted/70">重置次数</span>
      <span className="tabular-nums text-deck-muted">{count === null ? '暂不可读' : `${count} 次`}</span>
      {available && <button
        type="button"
        onClick={() => void useReset()}
        disabled={disabled || state.phase !== 'idle'}
        aria-label="为 Codex CLI 使用 1 次重置"
        className="ml-auto inline-flex items-center gap-1 rounded border border-status-working/25 bg-status-working/10 px-1.5 py-0.5 text-[10px] leading-4 text-status-working hover:bg-status-working/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <RefreshIcon className={`h-2.5 w-2.5 ${state.phase === 'running' ? 'animate-spin' : ''}`} />
        {state.phase === 'running' ? '重置中' : state.idempotencyKey ? '重试' : '使用 1 次'}
      </button>}
    </div>
    {state.error && <p role="alert" className="mt-1 text-status-error">{state.error}</p>}
    {state.message && <p role="status" className="mt-1 text-deck-muted/70">{state.message}</p>}
  </div>;
}
