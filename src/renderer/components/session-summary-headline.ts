import type { SessionPresentationSummarySource } from '@contracts/session-presentation';

export interface SessionSummaryHeadline {
  line: string;
  title: string;
}

export function sessionSummaryHeadline(
  content: string | null | undefined,
  generationSource: SessionPresentationSummarySource | null | undefined,
  fallback: string,
): SessionSummaryHeadline {
  const normalized = content?.trim();
  const headline = normalized?.split('\n')[0]?.trim();
  if (!headline) return { line: fallback, title: fallback };
  const degraded = generationSource === 'assistant-fallback' || generationSource === 'stats-fallback';
  return {
    line: `${degraded ? '降级 · ' : ''}${headline}`,
    title: normalized ?? headline,
  };
}
