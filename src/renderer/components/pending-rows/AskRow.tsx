import { useMemo, useState, type JSX } from 'react';
import type {
  AgentEvent,
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  AskUserQuestionRequest,
} from '@shared/types';
import { CheckboxIcon } from '../icons';
import log from '@renderer/utils/logger';
import { askDraftKeys } from './review-detail/ask-draft-identity';
import { ExpandableFeedbackField } from './review-detail/ExpandableFeedbackField';
import {
  RowResponseError,
  useRowResponseState,
} from './review-detail/row-response-state';

type AskDraft = { selected: string[]; other?: string; note?: string };
const logger = log.scope('renderer-ask-row');

export function AskRow({
  event,
  payload,
  sessionId,
  agentId,
  isSdk,
  stillPending,
  wasCancelled,
  onResolved,
  respondOverride,
  responseDisabled = false,
}: {
  event: AgentEvent;
  payload: AskUserQuestionRequest;
  sessionId: string;
  agentId: string;
  isSdk: boolean;
  stillPending: boolean;
  wasCancelled: boolean;
  onResolved: (sessionId: string, requestId: string) => void;
  respondOverride?: (answer: AskUserQuestionAnswer) => Promise<void>;
  responseDisabled?: boolean;
}): JSX.Element {
  const [selections, setSelections] = useState<Record<string, AskDraft>>({});
  const { busy: rowBusy, error, run } = useRowResponseState(payload.requestId);
  const busy = rowBusy || responseDisabled;
  const draftKeys = useMemo(() => askDraftKeys(payload), [payload]);
  const ts = new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false });
  const totalQuestions = payload.questions.length;
  const answeredCount = payload.questions.reduce((acc, _question, index) => {
    const cur = selections[draftKeys[index]!];
    const hasSel = (cur?.selected.length ?? 0) > 0;
    const hasOther = (cur?.other ?? '').trim().length > 0;
    return acc + (hasSel || hasOther ? 1 : 0);
  }, 0);
  const canSubmit = answeredCount === totalQuestions;

  const toggle = (key: string, q: AskUserQuestionItem, label: string): void => {
    setSelections((prev) => {
      const cur = prev[key] ?? { selected: [], other: undefined, note: undefined };
      const has = cur.selected.includes(label);
      const nextSel = q.multiSelect
        ? has
          ? cur.selected.filter((s) => s !== label)
          : [...cur.selected, label]
        : has
          ? []
          : [label];
      return { ...prev, [key]: { selected: nextSel, other: cur.other, note: cur.note } };
    });
  };

  const setOther = (key: string, value: string): void => {
    setSelections((prev) => {
      const cur = prev[key] ?? { selected: [], other: undefined };
      return { ...prev, [key]: { selected: cur.selected, other: value, note: cur.note } };
    });
  };

  const setNote = (key: string, value: string): void => {
    setSelections((prev) => {
      const cur = prev[key] ?? { selected: [], other: undefined, note: undefined };
      return { ...prev, [key]: { selected: cur.selected, other: cur.other, note: value } };
    });
  };

  const submit = async (): Promise<void> => {
    if (!isSdk || !stillPending || busy) return;
    const answers = payload.questions.map((question, index) => {
      const cur = selections[draftKeys[index]!] ?? {
        selected: [],
        other: undefined,
        note: undefined,
      };
      return {
        question: question.question,
        selected: cur.selected,
        other: cur.other,
        note: cur.note,
      };
    });
    const answer = { answers };
    const result = await run(
      async () => {
        if (respondOverride) {
          await respondOverride(answer);
          return;
        }
        await window.api.respondAskUserQuestion(
          agentId,
          sessionId,
          payload.requestId,
          answer,
        );
      },
      '回答提交失败，请确认问题仍在等待后重试。',
    );
    if (result.ok) {
      onResolved(sessionId, payload.requestId);
    } else if (result.error) {
      logger.error('ask response failed', {
        action: 'respondAskUserQuestion',
        agentId,
        sessionId,
        requestId: payload.requestId,
        error: result.error,
      });
    }
  };

  return (
    <li
      className={`min-w-0 rounded-md border p-2 text-[11px] ${
        stillPending
          ? 'border-status-working/40 bg-status-working/10'
          : wasCancelled
            ? 'border-deck-border/40 bg-white/[0.015] opacity-50'
            : 'border-deck-border/60 bg-white/[0.02] opacity-70'
      }`}
    >
      <div className="mb-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px]">
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
      <div className="flex min-w-0 flex-col gap-2">
        {payload.questions.map((q, qi) => {
          const draftKey = draftKeys[qi]!;
          const draft = selections[draftKey];
          const sel = draft?.selected ?? [];
          return (
            <div key={draftKey} className="min-w-0">
              {q.header && (
                <div className="mb-0.5 text-[9px] font-medium text-deck-muted">
                  {q.header}
                </div>
              )}
              <div className="mb-1 break-words text-[11px] text-deck-text">{q.question}</div>
              <div className="flex flex-wrap gap-1">
                {q.options.map((opt, optionIndex) => {
                  const isSel = sel.includes(opt.label);
                  return (
                    <button
                      key={`${opt.label}:${optionIndex}`}
                      type="button"
                      disabled={!isSdk || !stillPending || busy}
                      aria-pressed={isSel}
                      onClick={() => toggle(draftKey, q, opt.label)}
                      title={opt.description}
                      className={`max-w-full break-words rounded border px-2 py-0.5 text-[10px] disabled:opacity-50 ${
                        isSel
                          ? 'border-status-working/60 bg-status-working/30 text-status-working'
                          : 'border-deck-border bg-white/[0.04] text-deck-muted hover:bg-white/[0.08]'
                      }`}
                    >
                      {q.multiSelect && <CheckboxIcon checked={isSel} className="mr-1 inline h-3 w-3" />}
                      {opt.label}
                    </button>
                  );
                })}
              </div>
              <input
                type="text"
                value={draft?.other ?? ''}
                onChange={(e) => setOther(draftKey, e.target.value)}
                placeholder="其他（可选）"
                disabled={!isSdk || !stillPending || busy}
                className="mt-1 w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[10px] outline-none focus:border-white/20 disabled:opacity-50"
              />
              <div className="mt-1">
                <ExpandableFeedbackField
                  sessionId={sessionId}
                  requestId={payload.requestId}
                  fieldId={`note:${draftKey}`}
                  label={`${q.header ?? `第 ${qi + 1} 题`}备注`}
                  value={draft?.note ?? ''}
                  onChange={(value) => setNote(draftKey, value)}
                  placeholder="备注（可选）"
                  rows={2}
                  disabled={!isSdk || !stillPending || busy}
                />
              </div>
            </div>
          );
        })}
      </div>
      <RowResponseError>{error}</RowResponseError>
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
