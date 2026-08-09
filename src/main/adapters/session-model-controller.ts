/** Stable desktop facade for provider-neutral model-option persistence and rollback. */
import {
  SessionModelControllerCore,
  type SessionModelControllerContext,
} from './session-model-controller-core';
import { desktopSessionModelControllerHost } from './session-model-controller-host';

export type { SessionModelControllerContext } from './session-model-controller-core';

export class SessionModelController extends SessionModelControllerCore {
  constructor(ctx: SessionModelControllerContext) {
    super(ctx, desktopSessionModelControllerHost);
  }
}
