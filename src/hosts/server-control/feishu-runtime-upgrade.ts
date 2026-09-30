import type { JsonValue } from '@contracts/index';
import type { FeishuProvisioningPaths } from './feishu-provisioning';
import { activateDesiredFeishuRuntime, inspectFeishuRuntimeRelease, type AppliedFeishuRuntimeRelease } from './feishu-runtime-release';
import { checkpointFeishuState, type FeishuStateCheckpoint } from './feishu-state-checkpoint';
import type { FeishuRuntimeRetentionPort } from './feishu-runtime-retention';
import type { SystemdControlPort } from './systemd';

export async function upgradeFeishuRuntime(
  paths: FeishuProvisioningPaths,
  systemd: SystemdControlPort,
  requireHealthy: () => Promise<JsonValue>,
  retention: FeishuRuntimeRetentionPort,
  stateOwner: { uid: number; gid: number },
): Promise<JsonValue> {
  const state = inspectFeishuRuntimeRelease(paths);
  let runtime: AppliedFeishuRuntimeRelease | undefined;
  let checkpoint: FeishuStateCheckpoint | undefined;
  let stopped = false;
  let management: JsonValue;
  try {
    if (state.updateAvailable) {
      stopped = true;
      systemd.stop(paths.serviceUnit);
      if (systemd.isActive(paths.serviceUnit)) throw new Error('Feishu service did not stop for state checkpoint');
      checkpoint = checkpointFeishuState(paths, stateOwner);
    }
    runtime = activateDesiredFeishuRuntime(state);
    systemd.daemonReload();
    systemd.restart(paths.serviceUnit);
    management = await requireHealthy();
  } catch (error) {
    if (!runtime?.changed && !stopped) throw error;
    try {
      if (runtime?.changed) {
        systemd.stop(paths.serviceUnit);
        if (systemd.isActive(paths.serviceUnit)) throw new Error('Feishu service did not stop for state rollback');
        checkpoint!.restore();
        runtime.rollback();
      }
      systemd.restart(paths.serviceUnit);
      await requireHealthy();
    } catch (rollbackError) {
      throw new Error('Feishu runtime rollback was incomplete', { cause: rollbackError });
    }
    throw error;
  }
  try { checkpoint?.discard(); } catch { /* Retained private evidence does not invalidate health. */ }
  let cleanup: JsonValue = { status: 'skipped', removed: [], retained: [] };
  try { cleanup = { ...await retention.prune(paths, runtime) }; } catch {
    // Pruning is post-acceptance maintenance, never a reason to revert healthy service.
  }
  return {
    status: runtime.changed ? 'upgraded' : 'restarted-current',
    runtime: { activeDigest: runtime.activeDigest, previousDigest: runtime.previousDigest },
    management,
    cleanup,
  };
}
