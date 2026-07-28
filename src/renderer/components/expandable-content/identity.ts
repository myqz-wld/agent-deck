import type {
  AuthorizedContentReferenceId,
  ExpandableContentIdentity,
} from './types';

function logicalIdentityId(identity: ExpandableContentIdentity): string {
  switch (identity.kind) {
    case 'message':
      return identity.messageId;
    case 'request':
      return identity.requestId;
    case 'event':
      return identity.eventId;
    case 'payload':
      return identity.payloadId;
    case 'diagnostic':
      return identity.diagnosticId;
  }
}

/** Collision-safe key for selection/open state and React remount boundaries. */
export function expandableContentKey(identity: ExpandableContentIdentity): string {
  return JSON.stringify([
    identity.sessionId,
    identity.kind,
    logicalIdentityId(identity),
    identity.revision ?? null,
  ]);
}

/**
 * Brands an opaque resolver id while rejecting the two unsafe reference forms this
 * foundation must never retain: data URLs and direct filesystem paths.
 */
export function createAuthorizedContentReferenceId(
  value: string,
): AuthorizedContentReferenceId {
  const referenceId = value.trim();
  const isDataUrl = /^data:/i.test(referenceId);
  const isFileUrl = /^file:/i.test(referenceId);
  const isAbsolutePath =
    referenceId.startsWith('/')
    || referenceId.startsWith('\\\\')
    || /^[a-z]:[\\/]/i.test(referenceId);
  const isRelativePath =
    referenceId === '.'
    || referenceId === '..'
    || referenceId.startsWith('./')
    || referenceId.startsWith('../')
    || referenceId.startsWith('.\\')
    || referenceId.startsWith('..\\');
  const containsPathSeparator = referenceId.includes('/') || referenceId.includes('\\');
  const containsControlCharacter = /[\u0000-\u001f\u007f]/.test(referenceId);
  if (
    !referenceId
    || referenceId.length > 512
    || isDataUrl
    || isFileUrl
    || isAbsolutePath
    || isRelativePath
    || containsPathSeparator
    || containsControlCharacter
  ) {
    throw new Error('Content references must use a bounded opaque resolver id.');
  }
  return referenceId as AuthorizedContentReferenceId;
}
