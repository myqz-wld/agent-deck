import {
  PermissionResponderCore,
  type ResponderCtx,
  type RestartThunk,
} from './permission-responder-core';
import { desktopClaudePermissionResponderHost } from './permission-responder-host';

export type { ResponderCtx, RestartThunk } from './permission-responder-core';

export class PermissionResponder extends PermissionResponderCore {
  constructor(ctx: ResponderCtx, restartThunk: RestartThunk) {
    super(ctx, restartThunk, desktopClaudePermissionResponderHost);
  }
}
