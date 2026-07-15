import { useMemo, useState, type JSX } from 'react';
import { MemoizedMarkdownText } from '../MarkdownText';
import { ChevronDownIcon, ChevronUpIcon } from '../icons';

const PLAN_COLLAPSE_THRESHOLD_CHARS = 1_800;
const PLAN_COLLAPSE_THRESHOLD_LINES = 36;

export function PlanMarkdownPanel({ plan }: { plan: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const lineCount = plan.split('\n').length;
  const isLong =
    plan.length > PLAN_COLLAPSE_THRESHOLD_CHARS ||
    lineCount > PLAN_COLLAPSE_THRESHOLD_LINES;
  const renderedPlan = useMemo(
    () => (isLong && !expanded ? buildCollapsedPlanPreview(plan) : plan),
    [expanded, isLong, plan],
  );

  return (
    <div className="min-w-0 rounded border border-deck-border/40 bg-black/20 p-2">
      <div
        className={`min-h-0 ${
          isLong && !expanded ? 'max-h-[42vh] overflow-auto scrollbar-deck pr-1' : ''
        }`}
      >
        <MemoizedMarkdownText text={renderedPlan} />
      </div>
      {isLong && (
        <div className="mt-1.5 flex justify-end">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            className="rounded border border-deck-border bg-white/[0.04] px-2 py-0.5 text-[10px] text-deck-muted hover:bg-white/[0.08] hover:text-deck-text"
          >
            {expanded
              ? <ChevronUpIcon className="mr-1 inline h-3 w-3" />
              : <ChevronDownIcon className="mr-1 inline h-3 w-3" />}
            {expanded ? '收起' : `展开全部（${plan.length} 字）`}
          </button>
        </div>
      )}
    </div>
  );
}

function buildCollapsedPlanPreview(plan: string): string {
  const byLine = plan.split('\n').slice(0, PLAN_COLLAPSE_THRESHOLD_LINES).join('\n');
  const clipped =
    byLine.length > PLAN_COLLAPSE_THRESHOLD_CHARS
      ? byLine.slice(0, PLAN_COLLAPSE_THRESHOLD_CHARS).replace(/\s+\S*$/, '').trimEnd()
      : byLine;
  return clipped.length < plan.length ? `${clipped}\n\n...` : clipped;
}
