import type { ClaudeCwdTransitionContext } from './cwd-transition-controller-core';
import { ClaudeCwdTransitionControllerCore } from './cwd-transition-controller-core';
import { desktopClaudeCwdTransitionHost } from './cwd-transition-controller-host';

export class ClaudeCwdTransitionController extends ClaudeCwdTransitionControllerCore {
  constructor(context: ClaudeCwdTransitionContext) {
    super(context, desktopClaudeCwdTransitionHost);
  }
}
