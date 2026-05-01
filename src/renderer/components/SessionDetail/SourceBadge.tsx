import type { JSX } from 'react';

export function SourceBadge({ isSdk }: { isSdk: boolean }): JSX.Element {
  return isSdk ? (
    <span className="rounded bg-status-working/20 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-status-working">
      内
    </span>
  ) : (
    <span className="rounded bg-white/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-deck-muted">
      外
    </span>
  );
}
