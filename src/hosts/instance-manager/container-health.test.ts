import { describe, expect, it } from 'vitest';

import { waitForHealthyContainer } from './container-health';
import { createHarness, DIGEST_A } from './test-fixtures';

const NAME = 'agent-deck-relay-tenant-a';

function inspection(
  health: 'healthy' | 'starting' | 'unhealthy' | 'none',
  running = true,
) {
  return { name: NAME, image: DIGEST_A, health, running } as const;
}

describe('bounded container health convergence', () => {
  it('polls absent and starting states until the exact container is healthy', async () => {
    const harness = createHarness();
    harness.podman.containerInspectionSequences.set(NAME, [
      null,
      inspection('starting'),
      inspection('healthy'),
    ]);
    await expect(waitForHealthyContainer(harness.options, {
      name: NAME,
      image: DIGEST_A,
    })).resolves.toEqual(inspection('healthy'));
    expect(harness.healthSleeps).toEqual([250, 250]);
  });

  it.each(['unhealthy', 'none'] as const)(
    'fails immediately for %s instead of treating it as startup convergence',
    async (health) => {
      const harness = createHarness();
      harness.podman.containerInspectionSequences.set(NAME, [inspection(health)]);
      await expect(waitForHealthyContainer(harness.options, {
        name: NAME,
        image: DIGEST_A,
      })).rejects.toMatchObject({ code: 'health_failed' });
      expect(harness.healthSleeps).toEqual([]);
    },
  );

  it('terminates an absent-container poll at the configured total bound', async () => {
    const harness = createHarness();
    await expect(waitForHealthyContainer(harness.options, {
      name: NAME,
      image: DIGEST_A,
    })).rejects.toMatchObject({ code: 'health_failed' });
    expect(harness.healthSleeps.reduce((sum, value) => sum + value, 0)).toBe(
      harness.options.limits.healthTimeoutMs,
    );
  });
});
