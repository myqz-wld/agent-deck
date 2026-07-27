import type { JSX } from 'react';

export function formatTokenCount(value: number | null): string {
  if (value === null) return '—';
  return Math.max(0, value).toLocaleString();
}

export function TokenTotalCard({
  label,
  value,
  details,
}: {
  label: string;
  value: number | null;
  details: Array<[string, number | null]>;
}): JSX.Element {
  return (
    <div className="rounded bg-white/[0.04] px-2 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-deck-muted">{label}</span>
        <span className="text-sm font-medium tabular-nums text-deck-text">
          {formatTokenCount(value)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] tabular-nums text-deck-muted/70">
        {details.map(([detailLabel, detailValue]) => (
          <span key={detailLabel}>
            {detailLabel}{' '}
            <span className="text-deck-text/75">{formatTokenCount(detailValue)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
