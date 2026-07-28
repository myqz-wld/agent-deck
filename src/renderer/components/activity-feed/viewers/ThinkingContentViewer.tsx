import { useMemo, type JSX } from 'react';
import {
  ExpandableContent,
  type DiagnosticContentPayload,
} from '@renderer/components/expandable-content';
import { MarkdownText } from '@renderer/components/MarkdownText';
import type { RenderMode } from '../shared';

export function ThinkingContentViewer({
  sessionId,
  eventId,
  revision,
  text,
  title,
  mode,
  onToggleMode,
}: {
  sessionId: string;
  eventId: string;
  revision: number;
  text: string;
  title: string;
  mode: RenderMode;
  onToggleMode: () => void;
}): JSX.Element {
  const payload = useMemo<DiagnosticContentPayload>(() => ({
    kind: 'diagnostic',
    text,
    severity: 'info',
    metadata: { renderMode: mode, category: 'thinking' },
  }), [mode, text]);

  return (
    <ExpandableContent<DiagnosticContentPayload>
      identity={{ sessionId, kind: 'event', eventId, revision }}
      payload={payload}
      title={title}
      triggerLabel="展开思考详情"
      actions={text ? (
        <button
          type="button"
          onClick={onToggleMode}
          className="min-h-11 rounded px-3 text-xs text-deck-muted hover:bg-white/10 hover:text-deck-text"
        >
          {mode === 'markdown' ? '显示纯文本' : '显示 Markdown'}
        </button>
      ) : null}
    >
      {({ payload: selected }) => (
        <div className={`min-w-0 break-words text-sm leading-relaxed ${mode === 'markdown' ? '' : 'whitespace-pre-wrap'}`}>
          {selected.text
            ? mode === 'markdown'
              ? <MarkdownText text={selected.text} />
              : selected.text
            : <span className="text-deck-muted">暂无内容</span>}
        </div>
      )}
    </ExpandableContent>
  );
}
