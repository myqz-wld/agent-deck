import { useEffect, useState } from 'react';
import type { BrowserShowRequest, BrowserStateSource } from '@shared/browser-view';
import log from '@renderer/utils/logger';

const logger = log.scope('browser-show');

/** Refresh only an already mounted IAB panel; Browser requests never own app navigation. */
export function useBrowserShowRequest(source: BrowserStateSource, tabId: number | null): string | null {
  const sessionId = source.kind === 'local' ? source.sessionId : null;
  const [requestId, setRequestId] = useState<string | null>(null);
  useEffect(() => {
    const api = window.api as Partial<typeof window.api>;
    if (sessionId == null || tabId == null ||
      !api.onBrowserShowRequested || !api.getPendingBrowserShow) return;
    let sequence = 0;
    const accept = (requested: BrowserShowRequest | null): void => {
      const ownSequence = ++sequence;
      if (!requested || requested.source.sessionId !== sessionId || requested.tabId !== tabId) return;
      void api.getPendingBrowserShow!().then((pending) => {
        if (sequence === ownSequence && pending?.requestId === requested.requestId) {
          setRequestId(requested.requestId);
        }
      }).catch((error: unknown) => logger.warn('无法读取待显示的 IAB 标签。', error));
    };
    const off = api.onBrowserShowRequested(accept);
    const initialSequence = sequence;
    void api.getPendingBrowserShow().then((pending) => {
      if (sequence === initialSequence) accept(pending);
    }).catch((error: unknown) => logger.warn('无法读取待显示的 IAB 标签。', error));
    return () => { sequence += 1; off(); };
  }, [sessionId, tabId]);
  // Keep the last placement key after completion to avoid another native view update.
  return requestId;
}
