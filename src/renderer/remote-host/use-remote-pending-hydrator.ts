import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type {
  RemoteHostPendingListDto,
  RemoteHostSessionSummaryDto,
} from '@shared/remote-host';

import { loadPendingRows } from './remote-source-utils';

const PENDING_CONCURRENCY = 4;

interface RemotePendingHydratorOptions {
  identityRef: MutableRefObject<string>;
  listSequence: MutableRefObject<number>;
  setPendingBySession: Dispatch<SetStateAction<ReadonlyMap<string, RemoteHostPendingListDto>>>;
  setError: Dispatch<SetStateAction<string | null>>;
}

export function useRemotePendingHydrator({
  identityRef,
  listSequence,
  setPendingBySession,
  setError,
}: RemotePendingHydratorOptions): (
  profileId: string,
  expectedIdentity: string,
  expectedListSequence: number,
  rows: readonly RemoteHostSessionSummaryDto[],
) => void {
  return useCallback((profileId, expectedIdentity, expectedListSequence, rows): void => {
    void loadPendingRows(profileId, rows, PENDING_CONCURRENCY,
      window.api.listRemoteHostPending).then((results) => {
      if (identityRef.current !== expectedIdentity ||
          listSequence.current !== expectedListSequence) return;
      setPendingBySession((current) => {
        const next = new Map(current);
        for (const result of results) {
          if ('value' in result) next.set(result.id, result.value);
        }
        return next;
      });
      const failed = results.find((result) => 'reason' in result);
      if (failed && 'reason' in failed) {
        setError(failed.reason instanceof Error ? failed.reason.message : String(failed.reason));
      }
    });
  }, [identityRef, listSequence, setError, setPendingBySession]);
}
