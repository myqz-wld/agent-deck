import log from '@main/utils/logger';
import { getProcessRunId } from '@main/utils/run-context';
import { HookRouteDiagnostics } from './route-diagnostics';

export const hookRouteDiagnostics = new HookRouteDiagnostics({
  logger: log.scope('hook-routes'),
  runId: getProcessRunId,
});
