import type { RemoteHostSessionSummaryDto, RemoteHostSessionContextDto, RemoteHostSummaryListDto } from '@shared/remote-host';
import { RemoteReadCache } from '@shared/remote-read-cache';

/** Read-only display data; runtime/input/pending authority is always read again. */
export const remoteSessionDetailCache = new RemoteReadCache<{
  session: RemoteHostSessionSummaryDto;
  context: RemoteHostSessionContextDto | null;
  summaries: RemoteHostSummaryListDto | null;
}>(24);
