import { useEffect, useRef, useState, type JSX } from 'react';
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

const MODEL_PERSIST_DELAY_MS = 250;

interface RuntimeSelection {
  key: string;
  agentId: string;
  sessionId: string;
  model: string;
  thinking: SessionThinkingChoice;
  revision: number;
}

interface PendingPersistence {
  inFlight: boolean;
  queued: RuntimeSelection | null;
  modelTimer: ReturnType<typeof setTimeout> | null;
}

function sessionKey(session: SessionRecord): string {
  return `${session.agentId}:${session.id}`;
}

function selectionFromSession(session: SessionRecord, revision: number): RuntimeSelection {
  return {
    key: sessionKey(session),
    agentId: session.agentId,
    sessionId: session.id,
    model: session.model ?? '',
    thinking: normalizeThinking(session),
    revision,
  };
}

/** Editor for the runtime selection applied to subsequent provider turns. */
export function SessionRuntimeControls({ session }: { session: SessionRecord }): JSX.Element {
  const [model, setModel] = useState(session.model ?? '');
  const [thinking, setThinking] = useState<SessionThinkingChoice>(() => normalizeThinking(session));
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef({
    selection: selectionFromSession(session, 0),
    hasLocalEdits: false,
  });
  const persistenceRef = useRef(new Map<string, PendingPersistence>());
  const mountedRef = useRef(true);

  const getPendingPersistence = (key: string): PendingPersistence => {
    const existing = persistenceRef.current.get(key);
    if (existing) return existing;
    const pending = { inFlight: false, queued: null, modelTimer: null };
    persistenceRef.current.set(key, pending);
    return pending;
  };

  const isCurrentSelection = (selection: RuntimeSelection): boolean => {
    const current = draftRef.current.selection;
    return (
      mountedRef.current &&
      current.key === selection.key &&
      current.revision === selection.revision
    );
  };

  const persistQueuedSelection = async (key: string): Promise<void> => {
    const pending = persistenceRef.current.get(key);
    if (!pending || pending.inFlight || !pending.queued) return;

    const selection = pending.queued;
    pending.queued = null;
    pending.inFlight = true;
    try {
      await window.api.setSessionModelOptions(selection.agentId, selection.sessionId, {
        model: selection.model.trim() || null,
        thinking: selection.thinking || null,
      });
      if (isCurrentSelection(selection)) {
        draftRef.current.hasLocalEdits = false;
        setError(null);
      }
    } catch (err) {
      if (isCurrentSelection(selection)) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      pending.inFlight = false;
      if (!pending.modelTimer && pending.queued) {
        void persistQueuedSelection(key);
      } else if (!pending.modelTimer && !pending.queued) {
        persistenceRef.current.delete(key);
      }
    }
  };

  const queuePersistence = (selection: RuntimeSelection, immediately: boolean): void => {
    const pending = getPendingPersistence(selection.key);
    pending.queued = selection;
    if (immediately) {
      if (pending.modelTimer) clearTimeout(pending.modelTimer);
      pending.modelTimer = null;
      void persistQueuedSelection(selection.key);
      return;
    }

    if (pending.modelTimer) clearTimeout(pending.modelTimer);
    pending.modelTimer = setTimeout(() => {
      pending.modelTimer = null;
      void persistQueuedSelection(selection.key);
    }, MODEL_PERSIST_DELAY_MS);
  };

  const updateSelection = (
    update: Pick<RuntimeSelection, 'model'> | Pick<RuntimeSelection, 'thinking'>,
    immediately: boolean,
  ): void => {
    const key = sessionKey(session);
    const current = draftRef.current.selection;
    const base = current.key === key ? current : selectionFromSession(session, current.revision + 1);
    const next: RuntimeSelection = {
      ...base,
      ...update,
      revision: base.revision + 1,
    };
    draftRef.current = { selection: next, hasLocalEdits: true };
    setModel(next.model);
    setThinking(next.thinking);
    setError(null);
    queuePersistence(next, immediately);
  };

  useEffect(() => {
    const incoming = selectionFromSession(session, draftRef.current.selection.revision + 1);
    const draft = draftRef.current;
    if (draft.selection.key !== incoming.key) {
      draftRef.current = { selection: incoming, hasLocalEdits: false };
      setModel(incoming.model);
      setThinking(incoming.thinking);
      setError(null);
      return;
    }

    if (draft.hasLocalEdits) return;
    draftRef.current = { selection: incoming, hasLocalEdits: false };
    setModel(incoming.model);
    setThinking(incoming.thinking);
  }, [session.id, session.model, session.thinking, session.agentId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const [key, pending] of persistenceRef.current) {
        if (pending.modelTimer) {
          clearTimeout(pending.modelTimer);
          pending.modelTimer = null;
        }
        void persistQueuedSelection(key);
      }
    };
  }, []);

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
          onModelChange={(next) => updateSelection({ model: next }, false)}
          onThinkingChange={(next) => updateSelection({ thinking: next }, true)}
        />
        <p className="text-[9px] text-deck-muted/65">
          当前回复不会中断；修改会自动保存并在下一轮生效。模型名称及其支持的档位由 provider 最终校验。
        </p>
        <ErrorBanner message={error} prefix="模型设置失败" onDismiss={() => setError(null)} />
      </div>
    </details>
  );
}
