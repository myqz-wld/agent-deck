import { SESSION_DETAIL_MAX_SUMMARIES } from '@contracts/index';
import type {
  RemoteHostPendingListDto,
  RemoteHostRuntimeControlsDto,
  RemoteHostSessionSummaryDto,
  RemoteHostSummaryListDto,
  RemoteHostSessionContextDto,
  RemoteHostSessionInputCapabilitiesDto,
} from '@shared/remote-host';

interface RemoteSessionDetailTarget {
  profileId: string;
  sessionId: string;
}

export interface RemoteSessionOptionalResults {
  pending: PromiseSettledResult<RemoteHostPendingListDto | null>;
  runtime: PromiseSettledResult<RemoteHostRuntimeControlsDto | null>;
  summary: PromiseSettledResult<RemoteHostSummaryListDto | null>;
  context: PromiseSettledResult<RemoteHostSessionContextDto | null>;
  input: PromiseSettledResult<RemoteHostSessionInputCapabilitiesDto | null>;
}

export function startRemoteSessionDetailLoad(
  target: RemoteSessionDetailTarget,
  capabilities: ReadonlySet<string>,
): {
  session: Promise<RemoteHostSessionSummaryDto | null>;
  optional: Promise<RemoteSessionOptionalResults>;
} {
  const pending = capabilities.has('pending.read')
    ? window.api.listRemoteHostPending(target)
    : Promise.resolve(null);
  const runtime = capabilities.has('sessions.runtime.read')
    ? window.api.getRemoteHostRuntime(target)
    : Promise.resolve(null);
  const summary = capabilities.has('sessions.summaries.read')
    ? window.api.listRemoteHostSummaries({ ...target, limit: SESSION_DETAIL_MAX_SUMMARIES })
    : Promise.resolve(null);
  const context = capabilities.has('sessions.context.read')
    ? window.api.getRemoteHostSessionContext(target)
    : Promise.resolve(null);
  const input = capabilities.has('sessions.input.read')
    ? window.api.getRemoteHostSessionInputCapabilities(target)
    : Promise.resolve(null);
  return {
    session: window.api.getRemoteHostSession(target),
    optional: Promise.allSettled([pending, runtime, summary, context, input])
      .then(([pendingResult, runtimeResult, summaryResult, contextResult, inputResult]) => ({
        pending: pendingResult,
        runtime: runtimeResult,
        summary: summaryResult,
        context: contextResult,
        input: inputResult,
      })),
  };
}
