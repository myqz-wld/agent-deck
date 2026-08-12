import {
  NODE_CONFIGURATION_ADAPTER_IDS,
  type NodeConfigurationAdapterId,
  type NodeHookProjectionState,
} from '@contracts/index';

/** Runtime-owned, path-free Hook state populated only by authorized install/uninstall operations. */
export class ServerCoreNodeHookProjectionState {
  private readonly states = new Map<NodeConfigurationAdapterId, NodeHookProjectionState>();

  get(adapterId: NodeConfigurationAdapterId): NodeHookProjectionState | null {
    return this.states.get(adapterId) ?? null;
  }

  set(adapterId: NodeConfigurationAdapterId, state: NodeHookProjectionState): void {
    this.states.set(adapterId, state);
  }

  recordInstalled(adapterIds: readonly string[]): void {
    for (const adapterId of adapterIds) {
      if (NODE_CONFIGURATION_ADAPTER_IDS.includes(adapterId as NodeConfigurationAdapterId)) {
        this.states.set(adapterId as NodeConfigurationAdapterId, 'installed');
      }
    }
  }
}
