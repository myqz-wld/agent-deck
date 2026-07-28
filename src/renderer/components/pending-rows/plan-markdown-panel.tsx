import { useMemo, type JSX } from 'react';
import {
  ExpandableContent,
  type PlanReviewContentPayload,
} from '../expandable-content';
import { MemoizedMarkdownText } from '../MarkdownText';

const PLAN_PREVIEW_CHARS = 600;
const PLAN_PREVIEW_LINES = 6;

interface Props {
  plan: string;
  sessionId: string;
  requestId: string;
  title?: string;
  status: PlanReviewContentPayload['review']['status'];
}

export function PlanMarkdownPanel({
  plan,
  sessionId,
  requestId,
  title,
  status,
}: Props): JSX.Element {
  const preview = useMemo(() => buildPlanPreview(plan), [plan]);
  const payload: PlanReviewContentPayload = {
    kind: 'plan-review',
    document: {
      text: plan,
      format: 'markdown',
    },
    annotations: [],
    review: {
      requestId,
      status,
    },
  };

  return (
    <div className="relative min-w-0 rounded border border-deck-border/40 bg-black/20 p-2 pr-12">
      <div className="max-h-44 min-h-0 overflow-hidden">
        <MemoizedMarkdownText text={preview} />
      </div>
      <ExpandableContent<PlanReviewContentPayload>
        identity={{
          sessionId,
          kind: 'request',
          requestId: `${requestId}:plan`,
        }}
        payload={payload}
        title={title ? `完整计划 · ${title}` : '完整计划'}
        triggerLabel="展开完整计划"
      >
        {({ payload: expandedPayload }) => (
          <div className="mx-auto w-full max-w-6xl rounded border border-deck-border/60 bg-black/20 p-4 text-sm leading-relaxed">
            <MemoizedMarkdownText text={expandedPayload.document.text} />
          </div>
        )}
      </ExpandableContent>
    </div>
  );
}

function buildPlanPreview(plan: string): string {
  const byLine = plan.split('\n').slice(0, PLAN_PREVIEW_LINES).join('\n');
  const clipped =
    byLine.length > PLAN_PREVIEW_CHARS
      ? byLine.slice(0, PLAN_PREVIEW_CHARS).replace(/\s+\S*$/, '').trimEnd()
      : byLine;
  return clipped.length < plan.length ? `${clipped}\n\n…` : clipped;
}
