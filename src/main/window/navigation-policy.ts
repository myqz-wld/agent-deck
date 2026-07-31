import type { WebContents } from 'electron';
import log from '@main/utils/logger';
import { safeDiagnostic } from '@main/utils/safe-diagnostic';
import { getProcessRunId } from '@main/utils/run-context';
import {
  BoundedLogStateTracker,
  type LogStateDecision,
  type LogStateSnapshot,
} from '@main/utils/log-state-tracker';

const EXTERNAL_TRACKER_CAPACITY = 3;
const SUMMARY_INTERVAL_MS = 300_000;

type ExternalOperation = 'http' | 'https' | 'mailto';
type ExternalState = 'healthy' | 'open-failed';

interface AllowedExternalNavigation {
  operation: ExternalOperation;
  url: string;
}

type NavigationWebContents = Pick<WebContents, 'on' | 'setWindowOpenHandler'> & {
  getURL?: WebContents['getURL'];
};
type ExternalOpener = (url: string) => Promise<unknown>;

function createNavigationLogger(): ReturnType<typeof log.scope> | null {
  try {
    return log.scope('window-navigation');
  } catch {
    return null;
  }
}

function createExternalTracker(): BoundedLogStateTracker<
  ExternalOperation,
  ExternalState
> | null {
  try {
    return new BoundedLogStateTracker<ExternalOperation, ExternalState>({
      capacity: EXTERNAL_TRACKER_CAPACITY,
      summaryIntervalMs: SUMMARY_INTERVAL_MS,
    });
  } catch {
    return null;
  }
}

const logger = createNavigationLogger();
const externalTracker = createExternalTracker();

function classifyExternalNavigation(rawUrl: string): AllowedExternalNavigation | null {
  try {
    const parsed = new URL(rawUrl);
    const operation: ExternalOperation | null =
      parsed.protocol === 'http:'
        ? 'http'
        : parsed.protocol === 'https:'
          ? 'https'
          : parsed.protocol === 'mailto:'
            ? 'mailto'
            : null;
    return operation ? { operation, url: parsed.toString() } : null;
  } catch {
    return null;
  }
}

export function allowedExternalNavigationUrl(rawUrl: string): string | null {
  return classifyExternalNavigation(rawUrl)?.url ?? null;
}

function observeExternalState(
  operation: ExternalOperation,
  state: ExternalState,
): void {
  if (!externalTracker) return;
  try {
    emitExternalDecision(
      operation,
      externalTracker.observe(operation, {
        signature: state,
        abnormal: state !== 'healthy',
      }),
    );
  } catch {
    // External-open diagnostics cannot alter navigation policy.
  }
}

function emitExternalDecision(
  operation: ExternalOperation,
  decision: LogStateDecision<ExternalState>,
): void {
  if (decision.kind === 'repeat') return;
  if (decision.kind === 'initial' && !decision.current.abnormal) return;

  const priorAbnormal: LogStateSnapshot<ExternalState> | null =
    decision.flushed?.abnormal ? decision.flushed : null;
  const aggregate = priorAbnormal ?? decision.current;
  try {
    const details = safeDiagnostic({
      event: 'external-open-state',
      runId: getProcessRunId(),
      operation,
      state: decision.current.signature,
      previousState: decision.flushed?.signature ?? null,
      transition: decision.kind,
      abnormalDurationMs: aggregate.abnormalDurationMs,
      suppressedCount: aggregate.suppressedCount,
      suppressedCountCapped: aggregate.suppressedCountCapped,
      summaryIntervalMs: SUMMARY_INTERVAL_MS,
    });
    if (decision.current.abnormal) {
      logger?.warn(
        decision.kind === 'periodic-summary'
          ? 'external open state remains degraded'
          : 'external open state degraded',
        details,
      );
    } else if (priorAbnormal) {
      logger?.info('external open state recovered', details);
    }
  } catch {
    // Serialization and logging remain best-effort.
  }
}

function openAllowedExternal(rawUrl: string, openExternal: ExternalOpener): void {
  const external = classifyExternalNavigation(rawUrl);
  if (!external) return;
  void openExternal(external.url).then(
    () => observeExternalState(external.operation, 'healthy'),
    () => observeExternalState(external.operation, 'open-failed'),
  );
}

/**
 * Vite performs full-page navigations for some development changes. Those reloads must remain
 * inside the Electron renderer; sending the renderer URL to shell.openExternal opens a normal
 * browser without preload and produces a broken `window.api` page.
 *
 * Only an existing HTTP(S) renderer may navigate to another HTTP(S) URL within its exact origin.
 * Production file URLs and cross-origin destinations continue through the deny/external-open policy.
 */
export function isSameRendererOrigin(
  currentUrl: string,
  targetUrl: string,
): boolean {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    return (
      (current.protocol === 'http:' || current.protocol === 'https:') &&
      (target.protocol === 'http:' || target.protocol === 'https:') &&
      current.origin === target.origin
    );
  } catch {
    return false;
  }
}

/** Keep links and source-location clicks from replacing the single application renderer. */
export function installWindowNavigationPolicy(
  webContents: NavigationWebContents,
  openExternal: ExternalOpener,
): void {
  const currentUrl = (): string =>
    typeof webContents.getURL === 'function' ? webContents.getURL() : '';
  webContents.on('will-navigate', (event, url) => {
    if (isSameRendererOrigin(currentUrl(), url)) return;
    event.preventDefault();
    openAllowedExternal(url, openExternal);
  });
  webContents.setWindowOpenHandler(({ url }) => {
    if (!isSameRendererOrigin(currentUrl(), url)) {
      openAllowedExternal(url, openExternal);
    }
    return { action: 'deny' };
  });
}
