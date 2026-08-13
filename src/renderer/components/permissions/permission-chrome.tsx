import { useMemo, type JSX, type ReactNode } from 'react';
import type { SettingsSource } from '@shared/types';
import { RefreshIcon } from '../icons';

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

export function PermissionField({
  field,
  label,
  value,
  detail,
}: {
  field: string;
  label: string;
  value: ReactNode;
  detail?: ReactNode;
}): JSX.Element {
  return (
    <div
      className="grid grid-cols-[92px_minmax(0,1fr)] gap-2"
      data-permission-field={field}
    >
      <span className="text-deck-muted">{label}</span>
      <span className="min-w-0 break-words">
        <span className="font-mono text-deck-text/90">{value}</span>
        {detail && <span className="ml-1 text-[10px] text-deck-muted">{detail}</span>}
      </span>
    </div>
  );
}

export function PermissionRefreshField({
  field,
  label,
  value,
  loading,
  onRefresh,
}: {
  field: string;
  label: string;
  value: ReactNode;
  loading: boolean;
  onRefresh?: () => void;
}): JSX.Element {
  return (
    <div
      className="flex items-center justify-between gap-2 text-[10px] text-deck-muted"
      data-permission-field={field}
    >
      <div className="min-w-0 truncate">
        {label}：<span className="font-mono text-deck-text/80">{value}</span>
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={loading || !onRefresh}
        className="inline-flex shrink-0 items-center gap-1 rounded bg-white/10 px-2 py-0.5 text-deck-text hover:bg-white/15 disabled:opacity-50"
      >
        {!loading && <RefreshIcon className="h-3 w-3" />}
        {loading ? '刷新中…' : '刷新'}
      </button>
    </div>
  );
}

interface RawBlockProps {
  raw: string;
  title?: string;
  sessionId?: string;
  contentId?: string;
}

export function RawTextBlock({
  raw,
}: RawBlockProps): JSX.Element {
  return (
    <RawPre>{raw}</RawPre>
  );
}

export function RawJsonBlock({
  raw,
}: RawBlockProps): JSX.Element {
  const fragments = useMemo(() => highlightJson(raw), [raw]);
  return (
    <RawPre>{fragments}</RawPre>
  );
}

function RawPre({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 font-mono text-[10px] leading-snug text-deck-text/90 scrollbar-deck">
      {children}
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
