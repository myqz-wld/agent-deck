import type { InstanceManagerContext } from './context';
import type { PodmanContainerInspection } from './types';
import { fail } from './validation';

const HEALTH_POLL_INTERVAL_MS = 250;

export async function waitForHealthyContainer(
  context: InstanceManagerContext,
  expected: { readonly name: string; readonly image: string },
): Promise<PodmanContainerInspection> {
  const timeoutMs = context.limits.healthTimeoutMs;
  const startedAt = context.ports.clock.nowMs();
  const deadline = startedAt + timeoutMs;
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(deadline)) {
    fail('health_failed', 'container health deadline is invalid');
  }
  const maximumAttempts = Math.ceil(timeoutMs / HEALTH_POLL_INTERVAL_MS) + 2;
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const now = context.ports.clock.nowMs();
    if (attempt > 0 && now >= deadline) break;
    const remaining = Math.max(1, deadline - now);
    const inspected = await context.ports.podman.inspectContainer(
      expected.name,
      Math.min(context.limits.commandTimeoutMs, remaining),
    );
    if (inspected) {
      if (inspected.name !== expected.name || inspected.image !== expected.image) {
        fail('health_failed', 'container health identity does not match the expected version');
      }
      if (inspected.health === 'none') {
        fail('health_failed', 'container does not expose the required health contract');
      }
      if (inspected.health === 'unhealthy') {
        fail('health_failed', 'container reported an unhealthy terminal state');
      }
      if (inspected.running && inspected.health === 'healthy') return inspected;
    }
    const afterInspect = context.ports.clock.nowMs();
    if (afterInspect >= deadline) break;
    await context.ports.clock.sleep(Math.min(
      HEALTH_POLL_INTERVAL_MS,
      deadline - afterInspect,
    ));
  }
  fail('health_failed', 'container did not become healthy within the bounded deadline');
}
