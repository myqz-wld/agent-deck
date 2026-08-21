import type { JSX } from 'react';

import type { CallerArchiveFailedEvent } from '@shared/types';
import { StableButtonContent } from './components/StableButtonContent';

interface AppArchiveFailureBannerProps {
  failure: CallerArchiveFailedEvent;
  retryError: string | null;
  retrying: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}

export function AppArchiveFailureBanner({
  failure,
  retryError,
  retrying,
  onRetry,
  onDismiss,
}: AppArchiveFailureBannerProps): JSX.Element {
  return (
    <div role="alert" className="mx-3 mt-2 flex items-start gap-2 rounded border border-red-500/50 bg-red-500/10 p-2 text-[11px] text-red-100">
      <div className="min-w-0 flex-1">
        <div className="font-semibold">原会话归档失败</div>
        <div className="break-all text-red-100/90">{failure.reason}</div>
        {retryError && <div className="mt-1 break-all">重试归档失败：{retryError}</div>}
      </div>
      {failure.reasonKind !== 'row-missing' && (
        <button type="button" disabled={retrying} onClick={onRetry} className="shrink-0 rounded bg-red-400 px-2 py-1 font-semibold text-black disabled:opacity-50">
          <StableButtonContent
            activeKey={retrying ? 'busy' : 'idle'}
            variants={[
              { key: 'idle', content: '重试归档' },
              { key: 'busy', content: '重试中…' },
            ]}
          />
        </button>
      )}
      <button
        type="button"
        aria-label="关闭归档失败提示"
        onClick={onDismiss}
        className="shrink-0 rounded px-1 text-red-100/80 hover:bg-white/10"
      >
        ×
      </button>
    </div>
  );
}
