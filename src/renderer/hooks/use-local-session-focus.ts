import { useEffect } from 'react';

import log from '@renderer/utils/logger';

const logger = log.scope('renderer-local-session-focus');

/** Consume Local focus requests only after Local is the positively selected authority. */
export function useLocalSessionFocus(
  enabled: boolean,
  focusSession: (sessionId: string) => void,
): void {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let focusRequestSequence = 0;
    const focus = (sessionId: string): void => {
      if (!cancelled) focusSession(sessionId);
    };
    const consume = (fallback?: string): void => {
      const sequence = ++focusRequestSequence;
      void window.api.takePendingSessionFocus().then((sessionId) => {
        if (cancelled || sequence !== focusRequestSequence) return;
        const target = sessionId ?? fallback;
        if (target) focus(target);
      }).catch((error: unknown) => {
        if (cancelled || sequence !== focusRequestSequence) return;
        if (fallback) focus(fallback);
        logger.warn('[app] takePendingSessionFocus failed', error);
      });
    };
    const off = window.api.onSessionFocusRequest((sessionId) => consume(sessionId));
    consume();
    return () => {
      cancelled = true;
      focusRequestSequence += 1;
      off();
    };
  }, [enabled, focusSession]);
}
