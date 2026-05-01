import { type JSX } from 'react';
import type { FileChangeRecord } from '@shared/types';

export function ChangeTimeline({
  items,
  selectedId,
  onSelect,
}: {
  items: FileChangeRecord[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}): JSX.Element {
  return (
    <div className="shrink-0 max-h-32 overflow-y-auto scrollbar-deck rounded border border-deck-border/50 bg-white/[0.02] px-2 py-1.5">
      <ol className="relative ml-1.5 border-l border-white/10">
        {items.map((c, i) => {
          const isSelected = c.id === selectedId;
          const isLast = i === items.length - 1;
          return (
            <li key={c.id} className="relative pl-3 py-0.5">
              <span
                className={`absolute -left-[5px] top-1.5 inline-block h-2 w-2 rounded-full ring-2 ring-deck-bg ${
                  isSelected
                    ? 'bg-status-working'
                    : isLast
                    ? 'bg-deck-muted'
                    : 'bg-white/30'
                }`}
              />
              <button
                type="button"
                onClick={() => onSelect(c.id)}
                className={`flex w-full items-baseline gap-1.5 rounded px-1 py-0.5 text-left text-[10px] ${
                  isSelected
                    ? 'bg-white/10 text-deck-text'
                    : 'text-deck-muted hover:bg-white/5 hover:text-deck-text'
                }`}
                title={new Date(c.ts).toLocaleString('zh-CN', { hour12: false })}
              >
                <span className="font-mono tabular-nums">
                  {new Date(c.ts).toLocaleTimeString('zh-CN', { hour12: false })}
                </span>
                <span className="rounded bg-white/10 px-1 text-[9px] uppercase">{c.kind}</span>
                {isLast && (
                  <span className="ml-auto text-[9px] text-status-working/70">最新</span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
