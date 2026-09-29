import type { JsonObject } from '@contracts/index';
import type { FeishuProvisioningPaths } from './feishu-provisioning';
import { activateDesiredFeishuRuntime, inspectFeishuRuntimeRelease } from './feishu-runtime-release';
import type { FeishuRuntimeVerifierPort } from './feishu-runtime-verifier';
import { feishuRuntimeSummary } from './feishu-status';

/** Fresh connections use the installed release; established connections keep explicit upgrades. */
export async function connectWithDesiredFeishuRuntime<T>(
  paths: FeishuProvisioningPaths,
  verifier: FeishuRuntimeVerifierPort,
  connect: (runtime: JsonObject) => Promise<T>,
): Promise<T> {
  const state = inspectFeishuRuntimeRelease(paths);
  if (!state.updateAvailable) return connect(feishuRuntimeSummary(state));
  const applied = activateDesiredFeishuRuntime(state);
  try {
    verifier.verifyActive();
    return await connect(feishuRuntimeSummary(inspectFeishuRuntimeRelease(paths)));
  } catch (error) {
    try { applied.rollback(); } catch (rollbackError) {
      throw new Error('Feishu connection runtime rollback failed', {
        cause: new AggregateError([error, rollbackError]),
      });
    }
    throw error;
  }
}
