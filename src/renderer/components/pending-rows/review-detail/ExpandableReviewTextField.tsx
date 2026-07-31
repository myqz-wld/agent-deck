import type { JSX, KeyboardEvent, RefObject } from 'react';
import {
  ExpandableContent,
  type DiagnosticContentPayload,
} from '../../expandable-content';

interface Props {
  sessionId: string;
  requestId: string;
  fieldId: string;
  title: string;
  triggerLabel: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  id?: string;
  testId?: string;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  compactClassName?: string;
  onChange: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}

export function ExpandableReviewTextField({
  sessionId,
  requestId,
  fieldId,
  title,
  triggerLabel,
  value,
  placeholder,
  disabled,
  textareaRef,
  id,
  testId,
  ariaLabel,
  ariaDescribedBy,
  compactClassName = '',
  onChange,
  onKeyDown,
}: Props): JSX.Element {
  const payload: DiagnosticContentPayload = {
    kind: 'diagnostic',
    text: value,
    metadata: { field: title },
  };

  return (
    <div className="relative min-w-0">
      <textarea
        ref={textareaRef}
        id={id}
        data-testid={testId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        placeholder={placeholder}
        className={`w-full resize-none pr-10 ${compactClassName}`}
      />
      <ExpandableContent<DiagnosticContentPayload>
        identity={{
          sessionId,
          kind: 'request',
          requestId: `${requestId}:${fieldId}`,
        }}
        payload={payload}
        title={title}
        triggerLabel={triggerLabel}
        triggerVariant="input"
      >
        <textarea
          aria-label={`${title}（展开）`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          className="min-h-[60vh] w-full flex-1 resize-none rounded border border-deck-border bg-black/30 p-3 text-sm leading-relaxed text-deck-text outline-none placeholder:text-deck-muted/60 focus:border-white/25 disabled:opacity-50"
        />
      </ExpandableContent>
    </div>
  );
}
