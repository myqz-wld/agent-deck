import type { JSX, ReactNode } from 'react';
import {
  ExpandableContent,
  type ExpandableContentIdentity,
  type ExpandableContentPayload,
  type ExpandableContentRenderContext,
  type ExpandableHeavyViewSpec,
} from '../../expandable-content';

type ExpandedSlot<Payload extends ExpandableContentPayload> =
  | ReactNode
  | ((context: ExpandableContentRenderContext<Payload>) => ReactNode);

export interface ExpandablePermissionSurfaceProps<
  Payload extends ExpandableContentPayload,
> {
  identity: ExpandableContentIdentity;
  payload: Payload;
  title: string;
  triggerLabel: string;
  compact: ReactNode;
  expanded?: ExpandedSlot<Payload>;
  heavyView?: ExpandableHeavyViewSpec;
}

/**
 * Shared permission-viewer chrome. Typed payloads pass through unchanged; callers that own a
 * diff or image resolver must mount that renderer through heavyView.
 */
export function ExpandablePermissionSurface<
  Payload extends ExpandableContentPayload,
>({
  identity,
  payload,
  title,
  triggerLabel,
  compact,
  expanded,
  heavyView,
}: ExpandablePermissionSurfaceProps<Payload>): JSX.Element {
  return (
    <div className="relative min-w-0">
      {compact}
      <ExpandableContent<Payload>
        identity={identity}
        payload={payload}
        title={title}
        triggerLabel={triggerLabel}
        heavyView={heavyView}
      >
        {expanded}
      </ExpandableContent>
    </div>
  );
}
