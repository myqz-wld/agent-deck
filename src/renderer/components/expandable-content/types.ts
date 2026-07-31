import type { ReactNode } from 'react';

export type ExpandableContentIdentity =
  | {
      sessionId: string;
      kind: 'message';
      messageId: string;
      revision?: string | number;
    }
  | {
      sessionId: string;
      kind: 'request';
      requestId: string;
      revision?: string | number;
    }
  | {
      sessionId: string;
      kind: 'event';
      eventId: string;
      revision?: string | number;
    }
  | {
      sessionId: string;
      kind: 'payload';
      payloadId: string;
      revision?: string | number;
    }
  | {
      sessionId: string;
      kind: 'diagnostic';
      diagnosticId: string;
      revision?: string | number;
    };

export type ContentMetadataValue =
  | string
  | number
  | boolean
  | null
  | readonly string[];

export type ContentMetadata = Readonly<Record<string, ContentMetadataValue>>;

export type StructuredContentValue =
  | null
  | boolean
  | number
  | string
  | readonly StructuredContentValue[]
  | { readonly [key: string]: StructuredContentValue };

export interface MessageContentAttachment {
  id: string;
  name: string;
  mediaType?: string;
  size?: number;
  metadata?: ContentMetadata;
}

export interface MessageContentPayload {
  kind: 'message';
  text: string;
  attachments: readonly MessageContentAttachment[];
  metadata?: ContentMetadata;
}

export interface DiagnosticContentPayload {
  kind: 'diagnostic';
  text: string;
  severity?: 'info' | 'warning' | 'error';
  metadata?: ContentMetadata;
}

export type ExpandableContentPayload =
  | MessageContentPayload
  | DiagnosticContentPayload;

export type ExpandableCloseReason = 'close-button' | 'escape';

export interface ExpandableCloseBlockedEvent {
  reason: ExpandableCloseReason;
  cause: 'dirty-without-confirmation' | 'confirmation-declined' | 'confirmation-error';
}

export type ExpandableHeavyViewKind = 'monaco' | 'image' | 'image-diff' | 'custom';

export interface ExpandableHeavyViewLifecycleEvent {
  state: 'mounted' | 'unmounted';
  viewId: string;
  kind: ExpandableHeavyViewKind;
  contentKey: string;
  /** Process-local instrumentation; the enforced upper bound is one. */
  mountedCount: number;
}

export interface ExpandableHeavyViewSpec {
  id: string;
  kind: ExpandableHeavyViewKind;
  render: () => ReactNode;
  onLifecycle?: (event: ExpandableHeavyViewLifecycleEvent) => void;
}

export interface ExpandableContentRenderContext<Payload extends ExpandableContentPayload> {
  identity: ExpandableContentIdentity;
  payload: Payload;
  contentKey: string;
  closing: boolean;
  requestClose: (reason?: ExpandableCloseReason) => Promise<boolean>;
}
