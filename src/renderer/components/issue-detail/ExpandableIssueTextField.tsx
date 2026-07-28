import type { JSX } from 'react';
import {
  ExpandableContent,
  type DiagnosticContentPayload,
} from '../expandable-content';

interface Props {
  id?: string;
  issueId: string;
  sessionId: string;
  field: 'description' | 'repro';
  label: string;
  value: string;
  rows: number;
  maxLength: number;
  disabled: boolean;
  onChange: (value: string) => void;
}

export function ExpandableIssueTextField({
  id,
  issueId,
  sessionId,
  field,
  label,
  value,
  rows,
  maxLength,
  disabled,
  onChange,
}: Props): JSX.Element {
  const payload: DiagnosticContentPayload = {
    kind: 'diagnostic',
    text: value,
    metadata: {
      field: label,
      maxLength,
    },
  };
  return (
    <div className="relative min-w-0">
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        maxLength={maxLength}
        rows={rows}
        className="w-full resize-y rounded border border-deck-border bg-white/[0.04] py-1 pl-2 pr-12 text-xs text-deck-text outline-none focus:border-white/20 disabled:opacity-50"
      />
      <ExpandableContent<DiagnosticContentPayload>
        identity={{
          sessionId,
          kind: 'diagnostic',
          diagnosticId: `${issueId}:${field}`,
        }}
        payload={payload}
        title={label}
        triggerLabel={`展开${label.startsWith('Issue ') ? ' ' : ''}${label}`}
      >
        <textarea
          aria-label={`${label}（展开）`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled}
          maxLength={maxLength}
          className="min-h-[60vh] w-full flex-1 resize-none rounded border border-deck-border bg-black/30 p-3 text-sm leading-relaxed text-deck-text outline-none focus:border-white/25 disabled:opacity-50"
        />
      </ExpandableContent>
    </div>
  );
}
