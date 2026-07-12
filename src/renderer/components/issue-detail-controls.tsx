import { cloneElement, useId, type JSX } from 'react';
import type { IssueSeverity, IssueStatus } from '@shared/types';
import { ExternalLinkIcon } from './icons';

export const ISSUE_STATUS_OPTIONS: { value: IssueStatus; label: string }[] = [
  { value: 'open', label: 'open' },
  { value: 'in-progress', label: 'in-progress' },
  { value: 'resolved', label: 'resolved' },
];

export const ISSUE_SEVERITY_OPTIONS: { value: IssueSeverity; label: string }[] = [
  { value: 'low', label: 'LOW' },
  { value: 'medium', label: 'MEDIUM' },
  { value: 'high', label: 'HIGH' },
];

export function Field({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[10px] uppercase tracking-wide text-deck-muted">
        {label}
      </label>
      {cloneElement(children, { id })}
    </div>
  );
}

/** Session id link stays textual while its external-navigation action uses shared chrome. */
export function SessionLink({
  sid,
  onOpenSession,
}: {
  sid: string;
  onOpenSession?: (sid: string) => void;
}): JSX.Element {
  if (!onOpenSession) return <span className="font-mono">{sid}</span>;
  return (
    <button
      type="button"
      onClick={() => onOpenSession(sid)}
      title="打开该会话"
      className="truncate font-mono text-status-working underline-offset-2 hover:underline"
    >
      {sid}<ExternalLinkIcon className="ml-1 inline h-3 w-3" />
    </button>
  );
}
