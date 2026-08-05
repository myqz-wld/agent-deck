import type {
  RemoteHostJsonValue,
  RemoteHostPendingAction,
  RemoteHostPendingRequestDto,
} from '@shared/remote-host';
import { remoteHostQuestionIds } from '@shared/remote-host';

import type { RemotePendingPresentation } from './source-types';

function canonical(value: RemoteHostJsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}

export function pendingActionSurface(
  kind: RemoteHostPendingRequestDto['kind'],
): readonly RemoteHostPendingAction[] {
  if (kind === 'permission') return ['approve', 'deny'];
  if (kind === 'ask-user-question') return ['submit'];
  return ['accept', 'reject'];
}

export function pendingPresentationDigest(request: RemoteHostPendingRequestDto): string {
  return canonical({
    actions: [...pendingActionSurface(request.kind)],
    display: request.display,
    kind: request.kind,
    questionIds: remoteHostQuestionIds(request.display),
    status: request.status,
  });
}

export function remotePendingPresentation(
  sourceIdentity: string,
  revision: number,
  request: RemoteHostPendingRequestDto,
): RemotePendingPresentation {
  return {
    digest: pendingPresentationDigest(request),
    request,
    revision,
    sourceIdentity,
  };
}
