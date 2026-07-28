import type { JSX, KeyboardEvent } from 'react';
import {
  ExpandableContent,
  type DiagnosticContentPayload,
} from '../../expandable-content';

interface Props {
  sessionId: string;
  requestId: string;
  fieldId: string;
  label: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  autoFocus?: boolean;
  rows?: number;
  testId?: string;
  onChange: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}

export function ExpandableFeedbackField({
  sessionId,
  requestId,
  fieldId,
  label,
  value,
  placeholder,
  disabled,
  autoFocus,
  rows = 3,
  testId,
  onChange,
  onKeyDown,
}: Props): JSX.Element {
  const payload: DiagnosticContentPayload = {
    kind: 'diagnostic',
    text: value,
    metadata: { field: label },
  };
  return (
    <div className="relative min-w-0">
      <textarea
        autoFocus={autoFocus}
        data-testid={testId}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        className="w-full resize-y rounded border border-deck-border bg-white/[0.04] py-1 pl-2 pr-12 text-[10px] text-deck-text outline-none placeholder:text-deck-muted/70 focus:border-white/20 disabled:opacity-50"
      />
      <ExpandableContent<DiagnosticContentPayload>
        identity={{
          sessionId,
          kind: 'request',
          requestId: `${requestId}:${fieldId}`,
        }}
        payload={payload}
        title={label}
        triggerLabel={`展开${label}`}
      >
        <textarea
          aria-label={`${label}（展开）`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          className="min-h-[60vh] w-full flex-1 resize-none rounded border border-deck-border bg-black/30 p-3 text-sm leading-relaxed text-deck-text outline-none placeholder:text-deck-muted/60 focus:border-white/25 disabled:opacity-50"
        />
      </ExpandableContent>
    </div>
  );
}
