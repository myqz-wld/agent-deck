import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { BrowserShowRequest, BrowserStateSnapshot } from '@shared/browser-view';
import type { RemoteHostSourceMode } from '@shared/remote-host';
import log from '@renderer/utils/logger';

const logger = log.scope('browser-show');
export const useBrowserShowRequest = create<{ request: BrowserShowRequest | null }>(() => ({
  request: null,
}));

/** Explicit Browser show is a Local source choice, followed by owner-specific navigation. */
export function useBrowserShowFocus(
  localMode: boolean,
  setSourceMode: (mode: RemoteHostSourceMode) => Promise<void>,
  focusSession: (sessionId: string) => void,
): void {
  const current = useRef({ localMode, setSourceMode });
  current.current = { localMode, setSourceMode };
  const request = useBrowserShowRequest((state) => state.request);
  useEffect(() => {
    const api = window.api as Partial<typeof window.api>;
    if (!api.onBrowserShowRequested || !api.getPendingBrowserShow) return;
    let sequence = 0;
    const accept = (requested: BrowserShowRequest | null): void => {
      const ownSequence = ++sequence;
      useBrowserShowRequest.setState({ request: null });
      if (!requested) return;
      void (async () => {
        const pending = await api.getPendingBrowserShow!();
        if (ownSequence !== sequence || pending?.requestId !== requested.requestId) return;
        if (!current.current.localMode) await current.current.setSourceMode('local');
        const confirmed = await api.getPendingBrowserShow!();
        if (ownSequence !== sequence || confirmed?.requestId !== requested.requestId) return;
        useBrowserShowRequest.setState({ request: confirmed });
      })().catch((error: unknown) => logger.warn('无法显示请求的 IAB 标签。', error));
    };
    const off = api.onBrowserShowRequested(accept);
    const initialSequence = sequence;
    void api.getPendingBrowserShow().then((pending) => {
      if (sequence === initialSequence) accept(pending);
    }).catch((error: unknown) => logger.warn('无法读取待显示的 IAB 标签。', error));
    return () => {
      sequence += 1;
      off();
      useBrowserShowRequest.setState({ request: null });
    };
  }, []);

  useEffect(() => {
    if (localMode && request) focusSession(request.source.sessionId);
  }, [localMode, request, focusSession]);
}

/** Retain the presentation key after completion so the successful placement stays mounted. */
export function useBrowserShowTab(
  sessionId: string,
  snapshot: BrowserStateSnapshot | null,
  showBrowser: () => void,
): string {
  const request = useBrowserShowRequest((state) => state.request);
  const [presentationKey, setPresentationKey] = useState('manual');
  useEffect(() => {
    if (!request || request.source.sessionId !== sessionId ||
      snapshot?.source.kind !== 'local' || snapshot.source.sessionId !== sessionId ||
      !snapshot.tabs.some((tab) => tab.id === request.tabId) ||
      presentationKey === request.requestId) return;
    setPresentationKey(request.requestId);
    showBrowser();
  }, [request, sessionId, snapshot, presentationKey, showBrowser]);
  return presentationKey;
}
