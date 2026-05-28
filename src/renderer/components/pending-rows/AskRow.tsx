import { useState, type JSX } from 'react';
import type {
  AgentEvent,
  AskUserQuestionItem,
  AskUserQuestionRequest,
} from '@shared/types';

/**
 * AskUserQuestion 行（内嵌选项）。接口同 PermissionRow 模式。
 */
export function AskRow({
  event,
  payload,
  sessionId,
  agentId,
  isSdk,
  stillPending,
  wasCancelled,
  onResolved,
}: {
  event: AgentEvent;
  payload: AskUserQuestionRequest;
  sessionId: string;
  agentId: string;
  isSdk: boolean;
  stillPending: boolean;
  wasCancelled: boolean;
  onResolved: (sessionId: string, requestId: string) => void;
}): JSX.Element {
  const [selections, setSelections] = useState<Record<string, { selected: string[]; other?: string }>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const totalQuestions = payload.questions.length;
  const answeredCount = payload.questions.reduce((acc, q) => {
    const cur = selections[q.question];
    const hasSel = (cur?.selected.length ?? 0) > 0;
    const hasOther = (cur?.other ?? '').trim().length > 0;
    return acc + (hasSel || hasOther ? 1 : 0);
  }, 0);
  const canSubmit = answeredCount === totalQuestions;

  const toggle = (q: AskUserQuestionItem, label: string): void => {
    setSelections((prev) => {
      const cur = prev[q.question] ?? { selected: [], other: undefined };
      const has = cur.selected.includes(label);
      const nextSel = q.multiSelect
        ? has
          ? cur.selected.filter((s) => s !== label)
          : [...cur.selected, label]
        : has
          ? []
          : [label];
      return { ...prev, [q.question]: { selected: nextSel, other: cur.other } };
    });
  };

  const setOther = (q: AskUserQuestionItem, value: string): void => {
    setSelections((prev) => {
      const cur = prev[q.question] ?? { selected: [], other: undefined };
      return { ...prev, [q.question]: { selected: cur.selected, other: value } };
    });
  };

  const submit = async (): Promise<void> => {
    if (!isSdk || !stillPending || busy) return;
    setBusy(true);
    try {
      const answers = payload.questions.map((q) => {
        const cur = selections[q.question] ?? { selected: [], other: undefined };
        return { question: q.question, selected: cur.selected, other: cur.other };
      });
      await window.api.respondAskUserQuestion(agentId, sessionId, payload.requestId, { answers });
      onResolved(sessionId, payload.requestId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      className={`rounded-md border p-2 text-[11px] ${
        stillPending
          ? 'border-status-working/40 bg-status-working/10'
          : wasCancelled
            ? 'border-deck-border/40 bg-white/[0.015] opacity-50'
            : 'border-deck-border/60 bg-white/[0.02] opacity-70'
      }`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[10px]">
        <span
          className={
            stillPending
              ? 'text-status-working'
              : wasCancelled
                ? 'text-deck-muted/70'
                : 'text-status-working/80'
          }
        >
          {stillPending
            ? '❓ 收到一个问题'
            : wasCancelled
              ? '🚫 提问已被取消'
              : '✅ 已回答'}
        </span>
        {stillPending && (
          <span className="text-deck-muted/80">
            已回答 {answeredCount}/{totalQuestions} 题
          </span>
        )}
        <span className="font-mono tabular-nums text-deck-muted/60">{ts}</span>
        {stillPending && isSdk && (
          <button
            type="button"
            disabled={busy || answeredCount === 0}
            onClick={() => void submit()}
            title={canSubmit ? '提交回答' : '未答题目将留空提交'}
            className="ml-auto rounded bg-status-working px-2.5 py-0.5 text-[10px] font-semibold text-black shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            提交回答
          </button>
        )}
      </div>
      <div className="flex flex-col gap-2">
        {payload.questions.map((q, qi) => {
          const sel = selections[q.question]?.selected ?? [];
          return (
            <div key={qi}>
              <div className="mb-1 text-[11px] text-deck-text">{q.question}</div>
              <div className="flex flex-wrap gap-1">
                {q.options.map((opt) => {
                  const isSel = sel.includes(opt.label);
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      disabled={!isSdk || !stillPending || busy}
                      onClick={() => toggle(q, opt.label)}
                      title={opt.description}
                      className={`rounded border px-2 py-0.5 text-[10px] disabled:opacity-50 ${
                        isSel
                          ? 'border-status-working/60 bg-status-working/30 text-status-working'
                          : 'border-deck-border bg-white/[0.04] text-deck-muted hover:bg-white/[0.08]'
                      }`}
                    >
                      {q.multiSelect && <span className="mr-1">{isSel ? '☑' : '☐'}</span>}
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <input
                type="text"
                value={selections[q.question]?.other ?? ''}
                onChange={(e) => setOther(q, e.target.value)}
                placeholder="其他（可选）"
                disabled={!isSdk || !stillPending || busy}
                className="mt-1 w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[10px] outline-none focus:border-white/20 disabled:opacity-50"
              />
            </div>
          );
        })}
      </div>
      {stillPending && isSdk && (
        <div className="mt-2 flex items-center justify-end gap-2">
          <span className="text-[10px] text-deck-muted">
            {canSubmit ? '已答完,可提交' : `还有 ${totalQuestions - answeredCount} 题未答`}
          </span>
          <button
            type="button"
            disabled={busy || answeredCount === 0}
            onClick={() => void submit()}
            className="rounded bg-status-working px-3 py-1 text-[11px] font-semibold text-black shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            提交回答
          </button>
        </div>
      )}
      {!isSdk && (
        <div className="mt-1 text-[10px] text-deck-muted">这是终端启动的只读会话，请回到原终端窗口回答</div>
      )}
      {!stillPending && isSdk && wasCancelled && (
        <div className="mt-1 text-[10px] text-deck-muted/70">
          这次提问已取消
        </div>
      )}
    </li>
  );
}
