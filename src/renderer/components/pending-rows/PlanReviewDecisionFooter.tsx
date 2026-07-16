import type { JSX, RefObject } from 'react';

interface Props {
  feedback: string;
  feedbackRef: RefObject<HTMLTextAreaElement | null>;
  busy: boolean;
  canGenerate: boolean;
  generating: boolean;
  generated: boolean;
  error: string | null;
  onFeedbackChange: (value: string) => void;
  onGenerate: () => void;
  onRevise: () => void;
  onApprove: () => void;
}

export function PlanReviewDecisionFooter({
  feedback,
  feedbackRef,
  busy,
  canGenerate,
  generating,
  generated,
  error,
  onFeedbackChange,
  onGenerate,
  onRevise,
  onApprove,
}: Props): JSX.Element {
  return (
    <footer
      data-testid="plan-review-decision-footer"
      className="shrink-0 border-t border-deck-border bg-white/[0.02] px-4 py-3"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <section className="min-w-0" aria-busy={generating}>
          <div className="mb-1 flex items-center justify-between gap-2">
            <label
              htmlFor="plan-review-feedback"
              className="text-[10px] font-medium text-deck-text"
            >
              修改意见（可选）
            </label>
            <button
              type="button"
              disabled={busy || !canGenerate}
              onClick={onGenerate}
              className="rounded border border-deck-border bg-white/[0.06] px-2.5 py-1 text-[10px] text-deck-muted hover:bg-white/[0.12] hover:text-deck-text disabled:opacity-40"
            >
              {generating ? '正在生成意见…' : '根据上下文生成意见'}
            </button>
          </div>
          <textarea
            ref={feedbackRef}
            id="plan-review-feedback"
            data-testid="plan-review-feedback"
            value={feedback}
            onChange={(event) => onFeedbackChange(event.target.value)}
            disabled={busy}
            aria-describedby="plan-review-feedback-help"
            placeholder="输入希望调整的内容，或先让审阅会话生成草稿"
            className="min-h-16 max-h-32 w-full resize-y rounded border border-deck-border bg-black/30 px-2 py-1.5 text-[11px] text-deck-text outline-none placeholder:text-deck-muted/60 focus:border-white/25 disabled:opacity-50"
          />
          <div id="plan-review-feedback-help" className="mt-1 min-h-3 text-[9px] text-deck-muted/70">
            {error ? (
              <span role="alert" className="text-status-error">{error}</span>
            ) : generated ? (
              <span role="status" className="text-status-working">
                意见草稿已生成，请检查或修改后再提交。
              </span>
            ) : (
              '可以手动填写，也可以生成草稿；LLM 不会自动提交。'
            )}
          </div>
        </section>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onRevise}
            className="rounded border border-deck-border bg-white/[0.06] px-3 py-1.5 text-[10px] text-deck-text hover:bg-white/[0.12] disabled:opacity-40"
          >
            继续修改
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onApprove}
            className="rounded bg-status-working px-3 py-1.5 text-[10px] font-semibold text-black hover:brightness-110 disabled:opacity-40"
          >
            批准计划
          </button>
        </div>
      </div>
    </footer>
  );
}
