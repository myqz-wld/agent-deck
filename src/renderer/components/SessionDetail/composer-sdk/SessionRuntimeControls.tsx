import { useEffect, useMemo, useState, type JSX } from 'react';
import type { SessionRecord } from '@shared/types';
import {
  SessionModelFields,
  thinkingOptionsForAdapter,
  type SessionThinkingChoice,
} from '@renderer/components/SessionModelFields';
import { ErrorBanner } from './ErrorBanner';

function normalizeThinking(session: SessionRecord): SessionThinkingChoice {
  const value = session.thinking ?? '';
  return thinkingOptionsForAdapter(session.agentId).some((option) => option.value === value)
    ? (value as SessionThinkingChoice)
    : '';
}

/** Editor for the runtime selection applied to subsequent provider turns. */
export function SessionRuntimeControls({ session }: { session: SessionRecord }): JSX.Element {
  const [model, setModel] = useState(session.model ?? '');
  const [thinking, setThinking] = useState<SessionThinkingChoice>(() => normalizeThinking(session));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setModel(session.model ?? '');
    setThinking(normalizeThinking(session));
  }, [session.id, session.model, session.thinking, session.agentId]);

  const changed = useMemo(
    () =>
      model.trim() !== (session.model ?? '') ||
      (thinking || null) !== (session.thinking ?? null),
    [model, session.model, session.thinking, thinking],
  );

  const apply = async (): Promise<void> => {
    if (!changed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.api.setSessionModelOptions(session.agentId, session.id, {
        model: model.trim() || null,
        thinking: thinking || null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="mb-2 rounded border border-deck-border/80 bg-white/[0.02] px-2 py-1.5">
      <summary className="cursor-pointer select-none text-[10px] text-deck-muted">
        模型与思考程度
        <span className="ml-1 text-deck-muted/60">（下一轮生效）</span>
      </summary>
      <div className="mt-2 space-y-2">
        <SessionModelFields
          adapterId={session.agentId}
          model={model}
          thinking={thinking}
          disabled={busy}
          onModelChange={setModel}
          onThinkingChange={setThinking}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[9px] text-deck-muted/65">
            当前回复不会中断；模型名称及其支持的档位由 provider 最终校验。
          </span>
          <button
            type="button"
            disabled={!changed || busy}
            onClick={() => void apply()}
            className="h-7 shrink-0 rounded bg-status-working/20 px-2.5 text-[10px] text-status-working hover:bg-status-working/30 disabled:opacity-40"
          >
            {busy ? '应用中…' : '应用到下一轮'}
          </button>
        </div>
        <ErrorBanner message={error} prefix="模型设置失败" onDismiss={() => setError(null)} />
      </div>
    </details>
  );
}
