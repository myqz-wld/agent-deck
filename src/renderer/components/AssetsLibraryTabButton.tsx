import type { JSX, ReactNode } from 'react';

export function AssetsLibraryTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-[11px] transition ${
        active ? 'bg-white/10 text-deck-text' : 'text-deck-muted hover:bg-white/5 hover:text-deck-text/85'
      }`}
    >
      {children}
    </button>
  );
}
