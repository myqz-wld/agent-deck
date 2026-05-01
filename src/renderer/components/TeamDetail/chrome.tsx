import { type JSX, type ReactNode } from 'react';

/**
 * TeamDetail 的 chrome 三件套：Header / Section / Stat。
 * 都是 stateless layout helpers，无业务逻辑。
 */

export function Header({ name, onBack }: { name: string; onBack: () => void }): JSX.Element {
  return (
    <header className="flex items-center gap-2 border-b border-deck-border/40 px-3 py-2">
      <button
        type="button"
        onClick={onBack}
        className="rounded bg-white/8 px-2 py-0.5 text-[10px] text-deck-muted hover:bg-white/15"
      >
        ← 返回
      </button>
      <span className="text-[11px] text-deck-muted/70">🛡</span>
      <span className="flex-1 truncate text-[12px] font-medium">{name}</span>
    </header>
  );
}

export function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="mb-3">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-[10px] uppercase tracking-wider text-deck-muted/70">{title}</h3>
        {right && <div className="ml-auto">{right}</div>}
      </div>
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  ok,
}: {
  label: string;
  value: string;
  ok?: boolean;
}): JSX.Element {
  return (
    <div className="rounded border border-deck-border/40 bg-white/[0.02] px-2 py-1">
      <div className="text-[9px] uppercase tracking-wider text-deck-muted/60">{label}</div>
      <div
        className={`mt-0.5 text-[11px] ${
          ok === true ? 'text-status-working' : ok === false ? 'text-deck-muted/80' : ''
        }`}
      >
        {value}
      </div>
    </div>
  );
}
