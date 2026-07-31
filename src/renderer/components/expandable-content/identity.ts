import type { ExpandableContentIdentity } from './types';

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
