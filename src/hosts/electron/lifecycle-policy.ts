import type { ElectronHostRegistry } from './registry';

export interface ElectronHostLifecyclePolicy {
  windowClose: 'keep-transports' | 'stop-transports';
  appShutdown: 'stop-transports';
  remoteCoreLifecycle: 'never-owned-by-electron';
}

export const DEFAULT_ELECTRON_HOST_LIFECYCLE_POLICY: ElectronHostLifecyclePolicy = Object.freeze({
  windowClose: 'keep-transports',
  appShutdown: 'stop-transports',
  remoteCoreLifecycle: 'never-owned-by-electron',
});

/**
 * Window lifecycle and transport lifecycle are deliberately separate. Stopping a transport
 * closes only the desktop SSH child; no policy path owns or stops a remote session/Core.
 */
export class ElectronHostLifecycleController {
  constructor(
    private readonly registry: ElectronHostRegistry,
    readonly policy: ElectronHostLifecyclePolicy = DEFAULT_ELECTRON_HOST_LIFECYCLE_POLICY,
  ) {}

  async handleWindowClosed(): Promise<void> {
    if (this.policy.windowClose === 'stop-transports') {
      await this.registry.stopAll('window-close');
    }
  }

  async handleAppShutdown(): Promise<void> {
    await this.registry.stopAll('app-shutdown');
  }
}
