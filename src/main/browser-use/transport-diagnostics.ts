import log from '@main/utils/logger';
import { getProcessRunId } from '@main/utils/run-context';
import { safeDiagnostic } from '@main/utils/safe-diagnostic';

import type { BrowserUseTransportLimitError } from './protocol';

const logger = log.scope('browser-transport');

export type BrowserTransportReason =
  | BrowserUseTransportLimitError['reason']
  | 'dispose-error'
  | 'drain-timeout'
  | 'handler-error'
  | 'inflight-limit'
  | 'input-protocol-error'
  | 'invalid-request'
  | 'output-encoding-error'
  | 'output-queue-limit'
  | 'server-error'
  | 'socket-error'
  | 'socket-write-error';

export type BrowserTransportOperation =
  | 'allowDownload'
  | 'attach'
  | 'attachTarget'
  | 'claimUserTab'
  | 'createTab'
  | 'detach'
  | 'detachTarget'
  | 'executeCdp'
  | 'finalizeTabs'
  | 'getInfo'
  | 'getTabs'
  | 'getUserHistory'
  | 'getUserTabs'
  | 'markTab'
  | 'moveMouse'
  | 'nameSession'
  | 'ping'
  | 'turnEnded'
  | 'unknown';

export interface BrowserTransportReportContext {
  operation?: BrowserTransportOperation;
  requestKind?: 'notification' | 'request';
}

const SAFE_BROWSER_OPERATIONS = new Set<BrowserTransportOperation>([
  'allowDownload',
  'attach',
  'attachTarget',
  'claimUserTab',
  'createTab',
  'detach',
  'detachTarget',
  'executeCdp',
  'finalizeTabs',
  'getInfo',
  'getTabs',
  'getUserHistory',
  'getUserTabs',
  'markTab',
  'moveMouse',
  'nameSession',
  'ping',
  'turnEnded',
]);

export function safeBrowserOperation(method: string): BrowserTransportOperation {
  return SAFE_BROWSER_OPERATIONS.has(method as BrowserTransportOperation)
    ? method as BrowserTransportOperation
    : 'unknown';
}

export function reportBrowserServerError(
  onError: (error: unknown) => void,
): void {
  const diagnostic = safeDiagnostic({
    event: 'browser-transport',
    runId: getProcessRunId(),
    outcome: 'closed',
    reason: 'server-error',
  });
  logger.warn('server state changed', diagnostic);
  try {
    onError(diagnostic);
  } catch {
    // Diagnostics must never change server state.
  }
}
