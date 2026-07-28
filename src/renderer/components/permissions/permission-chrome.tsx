import { useMemo, type JSX, type ReactNode } from 'react';
import type { SettingsSource } from '@shared/types';
import type { DiagnosticContentPayload } from '../expandable-content';
import { ExpandablePermissionSurface } from './b18/ExpandablePermissionSurface';

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

interface RawBlockProps {
  raw: string;
  title?: string;
  sessionId?: string;
  contentId?: string;
}

function rawPayload(raw: string, format: 'text' | 'json'): DiagnosticContentPayload {
  return {
    kind: 'diagnostic',
    text: raw,
    severity: 'info',
    metadata: { format },
  };
}

function expandLabel(title: string): string {
  return /^[A-Za-z]/.test(title) ? `展开查看 ${title}` : `展开查看${title}`;
}

export function RawTextBlock({
  raw,
  title = '配置原文',
  sessionId = 'permission-settings',
  contentId = title,
}: RawBlockProps): JSX.Element {
  const payload = rawPayload(raw, 'text');
  return (
    <ExpandablePermissionSurface
      identity={{ sessionId, kind: 'diagnostic', diagnosticId: contentId }}
      payload={payload}
      title={title}
      triggerLabel={expandLabel(title)}
      compact={<RawPre className="max-h-72 pr-12">{raw}</RawPre>}
      expanded={({ payload: expandedPayload }) => (
        <RawPre className="min-h-full text-xs leading-relaxed">
          {expandedPayload.text}
        </RawPre>
      )}
    />
  );
}

export function RawJsonBlock({
  raw,
  title = 'JSON 原文',
  sessionId = 'permission-settings',
  contentId = title,
}: RawBlockProps): JSX.Element {
  const fragments = useMemo(() => highlightJson(raw), [raw]);
  const payload = rawPayload(raw, 'json');
  return (
    <ExpandablePermissionSurface
      identity={{ sessionId, kind: 'diagnostic', diagnosticId: contentId }}
      payload={payload}
      title={title}
      triggerLabel={expandLabel(title)}
      compact={<RawPre className="max-h-72 pr-12">{fragments}</RawPre>}
      expanded={({ payload: expandedPayload }) => (
        <RawPre className="min-h-full text-xs leading-relaxed">
          {highlightJson(expandedPayload.text)}
        </RawPre>
      )}
    />
  );
}

function RawPre({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <pre className={`overflow-auto scrollbar-deck whitespace-pre-wrap break-words rounded bg-black/30 p-2 font-mono text-[10px] leading-snug text-deck-text/90 ${className}`}>
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
