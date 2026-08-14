import type { RemoteHostPendingRequestDto } from '@shared/remote-host';
import {
  remoteHostPendingPresentationCanonical,
} from '@shared/remote-host';

import type { RemotePendingPresentation } from './source-types';

export function pendingPresentationDigest(request: RemoteHostPendingRequestDto): string {
  return remoteHostPendingPresentationCanonical(request);
}

export async function pendingPresentationBindingDigest(
  request: RemoteHostPendingRequestDto,
): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('当前环境无法绑定远程待处理展示。');
  }
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(remoteHostPendingPresentationCanonical(request)),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
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
