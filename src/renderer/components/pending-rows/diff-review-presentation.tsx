import { Fragment, useState, type JSX } from 'react';
import type {
  DiffPayload,
  DiffReviewAnnotation,
  DiffReviewAnnotationPane,
  DiffReviewRequest,
} from '@shared/types';
import { DiffViewer } from '../diff/DiffViewer';
import { ChevronDownIcon, ChevronUpIcon } from '../icons';

const PRESENTED_DIFF_HEIGHT = 'h-[60vh] min-h-96 max-h-[44rem]';
const PRESENTED_PANE_MAX_HEIGHT = 'max-h-[44rem]';
const LCS_CELL_LIMIT = 250_000;

type AnnotatedLineTone = 'added' | 'deleted';

export function DiffIntroCards({
  rationale,
  instructions,
}: {
  rationale: string;
  instructions?: string;
}): JSX.Element {
  const hasInstructions = Boolean(instructions);
  return (
    <div
      className={`mb-1.5 grid min-w-0 grid-cols-1 gap-1.5 ${
        hasInstructions ? 'md:grid-cols-2' : ''
      }`}
      data-testid="diff-intro-grid"
    >
      <IntroCard title="变更缘由" tone="primary">
        {rationale}
      </IntroCard>
      {hasInstructions && (
        <IntroCard title="确认点" tone="secondary">
          {instructions ?? ''}
        </IntroCard>
      )}
    </div>
  );
}

function IntroCard({
  title,
  tone,
  children,
}: {
  title: string;
  tone: 'primary' | 'secondary';
  children: string;
}): JSX.Element {
  return (
    <div
      className={`min-w-0 rounded border px-2 py-1.5 text-[10px] leading-relaxed ${
        tone === 'primary'
          ? 'border-status-working/25 bg-status-working/[0.08] text-deck-text'
          : 'border-deck-border/50 bg-white/[0.03] text-deck-muted/95'
      }`}
    >
      <div className="mb-0.5 text-[9px] font-semibold uppercase text-deck-muted/70">
        {title}
      </div>
      <div className="whitespace-pre-wrap break-words">{children}</div>
    </div>
  );
}

export function DiffPresentationPanel({
  payload,
  diffPayload,
  sessionId,
}: {
  payload: DiffReviewRequest;
  diffPayload: DiffPayload<string> | null;
  sessionId: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const size = getPresentationSize(payload);
  const label = payload.mode === 'merge-conflict' ? '冲突内容' : '差异内容';

  return (
    <div className="min-w-0 rounded border border-deck-border/40 bg-black/20 p-2">
      {expanded ? (
        <DiffPresentationContent
          payload={payload}
          diffPayload={diffPayload}
          sessionId={sessionId}
        />
      ) : (
        <div className="rounded border border-deck-border/40 bg-white/[0.02] px-2 py-2 text-[10px] text-deck-muted/85">
          {label}已收起
        </div>
      )}
      <div className="mt-1.5 flex justify-end">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="rounded border border-deck-border bg-white/[0.04] px-2 py-0.5 text-[10px] text-deck-muted hover:bg-white/[0.08] hover:text-deck-text"
        >
          {expanded ? <ChevronUpIcon className="mr-1 inline h-3 w-3" /> : <ChevronDownIcon className="mr-1 inline h-3 w-3" />}{expanded ? '收起' : `展开${payload.mode === 'merge-conflict' ? '冲突' : '差异'}（${size} 字）`}
        </button>
      </div>
    </div>
  );
}

function DiffPresentationContent({
  payload,
  diffPayload,
  sessionId,
}: {
  payload: DiffReviewRequest;
  diffPayload: DiffPayload<string> | null;
  sessionId: string;
}): JSX.Element {
  const hasAnnotations = (payload.annotations?.length ?? 0) > 0;
  if (payload.mode === 'pr' && diffPayload) {
    if (hasAnnotations && payload.pr) {
      return <AnnotatedPrDiff payload={payload} />;
    }
    return (
      <div className={`${PRESENTED_DIFF_HEIGHT} flex min-w-0 overflow-hidden rounded border border-white/5`}>
        <DiffViewer payload={diffPayload} sessionId={sessionId} />
      </div>
    );
  }
  if (payload.mode === 'merge-conflict' && payload.conflict) {
    return <ConflictReviewGrid payload={payload} />;
  }
  return (
    <pre className={`${PRESENTED_PANE_MAX_HEIGHT} max-w-full overflow-auto scrollbar-deck rounded bg-black/30 px-1.5 pt-1.5 pb-5 text-[10px] leading-snug text-deck-muted`}>
      {JSON.stringify(payload, null, 2)}
    </pre>
  );
}

function AnnotatedPrDiff({ payload }: { payload: DiffReviewRequest }): JSX.Element {
  const p = payload.pr!;
  const tones = buildPrLineTones(p.before, p.after);
  return (
    <div
      className={`${PRESENTED_DIFF_HEIGHT} grid min-w-0 grid-cols-1 gap-1.5 overflow-hidden rounded border border-white/5 bg-black/20 p-1.5 lg:grid-cols-2`}
    >
      <AnnotatedCodePane
        label={p.beforeLabel ?? '原文'}
        content={p.before}
        pane="before"
        annotations={annotationsForPane(payload.annotations, 'before')}
        lineTones={tones.before}
        className="h-full min-h-0"
        bodyClassName="min-h-0 flex-1"
      />
      <AnnotatedCodePane
        label={p.afterLabel ?? '修改后'}
        content={p.after}
        pane="after"
        annotations={annotationsForPane(payload.annotations, 'after')}
        lineTones={tones.after}
        className="h-full min-h-0"
        bodyClassName="min-h-0 flex-1"
      />
    </div>
  );
}

export function buildPrDiffPayload(payload: DiffReviewRequest): DiffPayload<string> | null {
  if (payload.mode !== 'pr' || !payload.pr) return null;
  return {
    kind: 'text',
    filePath: payload.filePath ?? payload.title ?? 'diff-presentation',
    before: payload.pr.before,
    after: payload.pr.after,
    metadata: {
      source: 'mcp-diff-presentation',
      beforeLabel: payload.pr.beforeLabel,
      afterLabel: payload.pr.afterLabel,
      diff: payload.pr.unifiedDiff,
      language: payload.language,
    },
    ts: Date.now(),
  };
}

function getPresentationSize(payload: DiffReviewRequest): number {
  const annotationSize = (payload.annotations ?? []).reduce(
    (total, annotation) =>
      total + annotation.body.length + (annotation.title?.length ?? 0),
    0,
  );
  if (payload.mode === 'pr' && payload.pr) {
    return (
      payload.pr.before.length +
      payload.pr.after.length +
      (payload.pr.unifiedDiff?.length ?? 0) +
      annotationSize
    );
  }
  if (payload.mode === 'merge-conflict' && payload.conflict) {
    const c = payload.conflict;
    return [c.base, c.ours, c.theirs, c.resolution].reduce(
      (total, content) => total + (content?.length ?? 0),
      annotationSize,
    );
  }
  return JSON.stringify(payload, null, 2).length;
}

function ConflictReviewGrid({ payload }: { payload: DiffReviewRequest }): JSX.Element {
  const c = payload.conflict!;
  const columns = [
    { key: 'ours', label: c.oursLabel ?? '当前', content: c.ours },
    { key: 'theirs', label: c.theirsLabel ?? '传入', content: c.theirs },
    { key: 'resolution', label: c.resolutionLabel ?? '建议结果', content: c.resolution },
  ];
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {c.base != null && (
        <ConflictPane
          label={c.baseLabel ?? '共同基础'}
          content={c.base}
          pane="base"
          annotations={annotationsForPane(payload.annotations, 'base')}
          className="max-h-64"
        />
      )}
      <div className="grid min-w-0 grid-cols-1 gap-1.5 lg:grid-cols-3">
        {columns.map((col) => (
          <ConflictPane
            key={col.key}
            label={col.label}
            content={col.content}
            pane={col.key as DiffReviewAnnotationPane}
            annotations={annotationsForPane(payload.annotations, col.key as DiffReviewAnnotationPane)}
          />
        ))}
      </div>
    </div>
  );
}

function ConflictPane({
  label,
  content,
  pane,
  annotations,
  className,
}: {
  label: string;
  content: string;
  pane: DiffReviewAnnotationPane;
  annotations: DiffReviewAnnotation[];
  className?: string;
}): JSX.Element {
  if (annotations.length > 0) {
    return (
      <AnnotatedCodePane
        label={label}
        content={content}
        pane={pane}
        annotations={annotations}
        bodyClassName={className}
      />
    );
  }
  return (
    <div className="min-w-0 overflow-hidden rounded border border-deck-border/50 bg-[#0f1218]">
      <div className="border-b border-deck-border/50 px-2 py-1 text-[10px] font-medium text-deck-muted/90">
        {label}
      </div>
      <pre
        className={`m-0 ${PRESENTED_PANE_MAX_HEIGHT} overflow-auto scrollbar-deck px-2 pt-2 pb-5 font-mono text-[10px] leading-5 text-deck-text ${className ?? ''}`}
      >
        {content}
      </pre>
    </div>
  );
}

function AnnotatedCodePane({
  label,
  content,
  pane,
  annotations,
  className,
  bodyClassName,
  lineTones,
}: {
  label: string;
  content: string;
  pane: DiffReviewAnnotationPane;
  annotations: DiffReviewAnnotation[];
  className?: string;
  bodyClassName?: string;
  lineTones?: Map<number, AnnotatedLineTone>;
}): JSX.Element {
  const lines = splitDisplayLines(content);
  const grouped = groupAnnotationsByLine(annotations, lines.length);
  return (
    <div
      className={`flex min-w-0 flex-col overflow-hidden rounded border border-deck-border/50 bg-[#0f1218] ${className ?? ''}`}
    >
      <div className="border-b border-deck-border/50 px-2 py-1 text-[10px] font-medium text-deck-muted/90">
        {label}
      </div>
      <div className={`overflow-auto scrollbar-deck pb-5 ${PRESENTED_PANE_MAX_HEIGHT} ${bodyClassName ?? ''}`}>
        <div className="font-mono text-[10px] leading-5 text-deck-text">
          <AnnotationCards pane={pane} line={0} annotations={grouped.get(0) ?? []} />
          {lines.map((line, index) => {
            const lineNumber = index + 1;
            const tone = lineTones?.get(lineNumber);
            return (
              <Fragment key={lineNumber}>
                <div
                  className={`grid ${
                    lineTones
                      ? 'grid-cols-[2.75rem_1rem_minmax(0,1fr)]'
                      : 'grid-cols-[2.75rem_minmax(0,1fr)]'
                  } gap-2 px-2 ${diffLineToneClass(tone)}`}
                  data-diff-tone={lineTones ? tone ?? 'context' : undefined}
                >
                  <span className="select-none text-right tabular-nums text-deck-muted/45">
                    {content === '' ? '' : lineNumber}
                  </span>
                  {lineTones && (
                    <span className={`select-none text-center ${diffLineMarkerClass(tone)}`}>
                      {tone === 'added' ? '+' : tone === 'deleted' ? '-' : ''}
                    </span>
                  )}
                  <span className="whitespace-pre-wrap break-words">{line || ' '}</span>
                </div>
                <AnnotationCards
                  pane={pane}
                  line={lineNumber}
                  annotations={grouped.get(lineNumber) ?? []}
                />
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function AnnotationCards({
  pane,
  line,
  annotations,
}: {
  pane: DiffReviewAnnotationPane;
  line: number;
  annotations: DiffReviewAnnotation[];
}): JSX.Element | null {
  if (annotations.length === 0) return null;
  return (
    <div className="space-y-1 px-2 py-1" data-pane={pane} data-line={line}>
      {annotations.map((annotation, index) => (
        <div
          key={`${annotation.pane}-${annotation.line ?? 0}-${index}`}
          data-testid="diff-annotation-card"
          className="rounded border border-status-working/35 bg-status-working/[0.10] px-2 py-1.5 font-sans text-[10px] leading-relaxed text-deck-text"
        >
          {annotation.title && (
            <div className="mb-0.5 font-semibold text-status-working">
              {annotation.title}
            </div>
          )}
          <div className="whitespace-pre-wrap break-words">{annotation.body}</div>
        </div>
      ))}
    </div>
  );
}

function annotationsForPane(
  annotations: DiffReviewAnnotation[] | undefined,
  pane: DiffReviewAnnotationPane,
): DiffReviewAnnotation[] {
  return (annotations ?? []).filter(
    (annotation) =>
      annotation.pane === pane ||
      (annotation.pane === 'both' && (pane === 'before' || pane === 'after')),
  );
}

function groupAnnotationsByLine(
  annotations: DiffReviewAnnotation[],
  lineCount: number,
): Map<number, DiffReviewAnnotation[]> {
  const grouped = new Map<number, DiffReviewAnnotation[]>();
  for (const annotation of annotations) {
    const rawLine = annotation.line ?? 0;
    const line = Math.min(Math.max(rawLine, 0), lineCount);
    const group = grouped.get(line) ?? [];
    group.push(annotation);
    grouped.set(line, group);
  }
  return grouped;
}

function splitDisplayLines(content: string): string[] {
  if (content === '') return [''];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function splitComparableLines(content: string): string[] {
  if (content === '') return [];
  return splitDisplayLines(content);
}

function buildPrLineTones(
  before: string,
  after: string,
): { before: Map<number, AnnotatedLineTone>; after: Map<number, AnnotatedLineTone> } {
  const beforeLines = splitComparableLines(before);
  const afterLines = splitComparableLines(after);
  const pairs =
    beforeLines.length * afterLines.length <= LCS_CELL_LIMIT
      ? longestCommonLinePairs(beforeLines, afterLines)
      : prefixSuffixCommonLinePairs(beforeLines, afterLines);
  const keptBefore = new Set(pairs.map(([beforeIndex]) => beforeIndex));
  const keptAfter = new Set(pairs.map(([, afterIndex]) => afterIndex));
  const beforeTones = new Map<number, AnnotatedLineTone>();
  const afterTones = new Map<number, AnnotatedLineTone>();

  beforeLines.forEach((_line, index) => {
    if (!keptBefore.has(index)) beforeTones.set(index + 1, 'deleted');
  });
  afterLines.forEach((_line, index) => {
    if (!keptAfter.has(index)) afterTones.set(index + 1, 'added');
  });

  return { before: beforeTones, after: afterTones };
}

function longestCommonLinePairs(before: string[], after: string[]): Array<[number, number]> {
  const dp = Array.from({ length: before.length + 1 }, () =>
    Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      dp[i][j] =
        before[i] === after[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

function prefixSuffixCommonLinePairs(before: string[], after: string[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    pairs.push([start, start]);
    start += 1;
  }

  let beforeEnd = before.length - 1;
  let afterEnd = after.length - 1;
  const suffix: Array<[number, number]> = [];
  while (beforeEnd >= start && afterEnd >= start && before[beforeEnd] === after[afterEnd]) {
    suffix.push([beforeEnd, afterEnd]);
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return [...pairs, ...suffix.reverse()];
}

function diffLineToneClass(tone: AnnotatedLineTone | undefined): string {
  if (tone === 'added') return 'bg-status-working/[0.10]';
  if (tone === 'deleted') return 'bg-status-error/[0.10]';
  return '';
}

function diffLineMarkerClass(tone: AnnotatedLineTone | undefined): string {
  if (tone === 'added') return 'text-status-working';
  if (tone === 'deleted') return 'text-status-error';
  return 'text-deck-muted/30';
}
