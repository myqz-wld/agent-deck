import { useEffect, useState, type JSX } from 'react';

const INITIAL_PREVIEW_CHARACTERS = 64 * 1024;

export function BoundedTextPreview({
  ariaLabel,
  content,
  className = '',
}: {
  ariaLabel?: string;
  content: string;
  className?: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => setExpanded(false), [content]);
  const truncated = content.length > INITIAL_PREVIEW_CHARACTERS;
  const visible = truncated && !expanded
    ? content.slice(0, INITIAL_PREVIEW_CHARACTERS)
    : content;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <pre
        aria-label={ariaLabel}
        className={`min-h-0 flex-1 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] scrollbar-deck rounded border border-deck-border bg-white/[0.04] p-2 font-mono text-[10px] leading-relaxed text-deck-text ${className}`}
        style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
      >
        {visible}
      </pre>
      {truncated && !expanded && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="self-start rounded bg-white/8 px-2 py-1 text-[10px] text-deck-muted hover:bg-white/15 hover:text-deck-text"
        >
          显示完整内容（{content.length.toLocaleString()} 字符）
        </button>
      )}
    </div>
  );
}
