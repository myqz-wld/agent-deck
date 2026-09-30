import type { JsonValue } from '@contracts/index';
import type { FeishuProvisioningPaths } from './feishu-provisioning';
import { activateDesiredFeishuRuntime, inspectFeishuRuntimeRelease } from './feishu-runtime-release';
import type { FeishuRuntimeRetentionPort } from './feishu-runtime-retention';
import type { SystemdControlPort } from './systemd';

export async function upgradeFeishuRuntime(
  paths: FeishuProvisioningPaths,
  systemd: SystemdControlPort,
  requireHealthy: () => Promise<JsonValue>,
  retention: FeishuRuntimeRetentionPort,
): Promise<JsonValue> {
  const runtime = activateDesiredFeishuRuntime(inspectFeishuRuntimeRelease(paths));
  let management: JsonValue;
  try {
    systemd.daemonReload();
    systemd.restart(paths.serviceUnit);
    management = await requireHealthy();
  } catch (error) {
    if (!runtime.changed) throw error;
    try {
      runtime.rollback();
      systemd.restart(paths.serviceUnit);
      await requireHealthy();
    } catch (rollbackError) {
      throw new Error('Feishu runtime rollback was incomplete', { cause: rollbackError });
    }
    throw error;
  }
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
