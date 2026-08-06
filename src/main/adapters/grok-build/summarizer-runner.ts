import type { RuntimeSelection, StoredAgentEvent } from '@shared/types';
import { summariseGrokSessionWithHost } from './summarizer-runner-core';
import { desktopGrokSummaryRunnerHost } from './summarizer-runner-host';

export {
  resolveGrokSummaryModel,
  resolveGrokSummaryReasoning,
} from './summarizer-runner-core';

/** Run a bounded, hardened Grok Build oneshot for the session-list display summary. */
export async function summariseGrokSessionViaOneshot(
  cwd: string,
  events: StoredAgentEvent[],
  evidenceContext?: string,
  runtime?: Pick<RuntimeSelection, 'provider' | 'model' | 'thinking'>,
): Promise<string | null> {
  return summariseGrokSessionWithHost(
    desktopGrokSummaryRunnerHost,
    cwd,
    events,
    evidenceContext,
    runtime,
  );
}
