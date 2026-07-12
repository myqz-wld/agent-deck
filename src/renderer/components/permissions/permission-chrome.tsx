import { useMemo, type JSX, type ReactNode } from 'react';
import type { SettingsSource } from '@shared/types';

export const SOURCE_LABEL: Record<SettingsSource, string> = {
  user: '全局设置',
  'user-local': '本机设置',
  project: '项目设置',
  local: '当前目录设置',
};

const SOURCE_BADGE: Record<SettingsSource, string> = {
  user: '全局',
  'user-local': '本机',
  project: '项目',
  local: '目录',
};

const SOURCE_HINT: Record<SettingsSource, string> = {
  user: '~/.claude/settings.json',
  'user-local': '~/.claude/settings.local.json',
  project: '<当前目录>/.claude/settings.json',
  local: '<当前目录>/.claude/settings.local.json',
};

export function SourceBadge({ source }: { source: SettingsSource }): JSX.Element {
  return (
    <span
      title={`${SOURCE_LABEL[source]} · ${SOURCE_HINT[source]}`}
      className="rounded border border-white/10 bg-black/30 px-1 font-mono text-[9px] text-deck-text/70"
    >
      {SOURCE_BADGE[source]}
    </span>
  );
}

export function RawTextBlock({ raw }: { raw: string }): JSX.Element {
  return (
    <pre className="max-h-72 overflow-auto scrollbar-deck rounded bg-black/30 p-2 font-mono text-[10px] leading-snug text-deck-text/90">
      {raw}
    </pre>
  );
}

export function RawJsonBlock({ raw }: { raw: string }): JSX.Element {
  const fragments = useMemo(() => highlightJson(raw), [raw]);
  return (
    <pre className="max-h-72 overflow-auto scrollbar-deck rounded bg-black/30 p-2 font-mono text-[10px] leading-snug text-deck-text/90">
      {fragments}
    </pre>
  );
}

const JSON_TOKEN_RE = /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function highlightJson(raw: string): ReactNode[] {
  if (!raw) return [];
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of raw.matchAll(JSON_TOKEN_RE)) {
    const index = match.index ?? 0;
    if (index > last) out.push(raw.slice(last, index));
    const [whole, key, str, keyword, number] = match;
    const className = key
      ? 'text-sky-300'
      : str
        ? 'text-emerald-300'
        : keyword
          ? 'text-amber-300'
          : number
            ? 'text-orange-300'
            : '';
    out.push(className ? <span key={`${i++}-${index}`} className={className}>{whole}</span> : whole);
    last = index + whole.length;
  }
  if (last < raw.length) out.push(raw.slice(last));
  return out;
}
