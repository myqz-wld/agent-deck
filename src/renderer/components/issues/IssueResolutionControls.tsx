import { useState, type JSX } from 'react';

import type { IssueRecord } from '@shared/types';
import type { IssueDetailDataSource } from '../IssueDetail';
import { ResolveInNewSessionDialog } from '../ResolveInNewSessionDialog';
import { HandOffIcon } from '../icons';
import { StableButtonContent } from '../StableButtonContent';
import { RemoteIssueResolutionDialog } from './RemoteIssueResolutionDialog';

export function IssueResolutionControls({
  issue,
  saving,
  source,
  onResolved,
}: {
  issue: IssueRecord;
  saving: boolean;
  source?: IssueDetailDataSource;
  onResolved(issue: IssueRecord): void;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (issue.deletedAt !== null || issue.status === 'resolved' || (source && !source.resolution)) {
    return null;
  }
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={saving}
        title={issue.resolutionSessionId
          ? '已有处理会话；新会话将接替后续处理操作'
          : undefined}
        className="rounded bg-status-working/25 px-2 py-1 text-xs text-status-working hover:bg-status-working/40 disabled:opacity-50"
      >
        <StableButtonContent
          activeKey={issue.resolutionSessionId ? 'replace' : 'create'}
          variants={[
            {
              key: 'create',
              content: <><HandOffIcon className="mr-1 h-3 w-3" />新建处理会话</>,
            },
            {
              key: 'replace',
              content: <><HandOffIcon className="mr-1 h-3 w-3" />更换处理会话</>,
            },
          ]}
        />
      </button>
      {!source && open && (
        <ResolveInNewSessionDialog
          issue={issue}
          onClose={() => setOpen(false)}
          onResolved={(updated) => {
            onResolved(updated);
            setOpen(false);
          }}
        />
      )}
      {source?.resolution && open && (
        <RemoteIssueResolutionDialog
          issue={issue}
          source={source.resolution.source}
          onClose={() => setOpen(false)}
          onResolve={(input) => source.resolution!.create(issue, input)}
          onResolved={(updated) => {
            onResolved(updated);
            setOpen(false);
          }}
        />
      )}
    </>
  );
}
