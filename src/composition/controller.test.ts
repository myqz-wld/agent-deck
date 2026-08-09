import type { AgentDeckClient } from '@contracts/index';
import { describe, expect, it, vi } from 'vitest';

import { AgentDeckCompositionController } from './controller';
import {
  createRelayServerComposition,
  createStandaloneComposition,
} from './topologies';
import type { LifecycleComponent } from './runtime';

function component(
  name: string,
  calls: string[],
  fail: 'start' | 'stop' | null = null,
): LifecycleComponent {
  return {
    name,
    async start() {
      calls.push(`start:${name}`);
      if (fail === 'start') throw new Error(`${name} start failed`);
    },
    async stop(reason) {
      calls.push(`stop:${name}:${reason}`);
      if (fail === 'stop') throw new Error(`${name} stop failed`);
    },
  };
}

describe('composition lifecycle ownership', () => {
  it('starts in declaration order and stops in reverse order', async () => {
    const calls: string[] = [];
    const controller = new AgentDeckCompositionController(
      createRelayServerComposition({
        components: [component('router', calls), component('ingress', calls)],
      }),
    );

    await controller.start();
    await controller.stop('operator-stop');
    expect(calls).toEqual([
      'start:router',
      'start:ingress',
      'stop:ingress:operator-stop',
      'stop:router:operator-stop',
    ]);
    expect(controller.state).toBe('stopped');
  });

  it('rolls back only components that actually started', async () => {
    const calls: string[] = [];
    const controller = new AgentDeckCompositionController(
      createRelayServerComposition({
        components: [
          component('metadata', calls),
          component('listener', calls, 'start'),
          component('never', calls),
        ],
      }),
    );

    await expect(controller.start()).rejects.toThrow('listener start failed');
    expect(calls).toEqual([
      'start:metadata',
      'start:listener',
      'stop:metadata:composition-start-failed',
    ]);
    expect(controller.state).toBe('stopped');
  });

  it('keeps the standalone client explicit and rejects duplicate components', () => {
    const client = { close: vi.fn() } as unknown as AgentDeckClient;
    const composition = createStandaloneComposition({
      client,
      components: [],
    });
    expect(composition.topology).toBe('standalone');
    expect(composition.client).toBe(client);
    expect(
      () =>
        new AgentDeckCompositionController(
          createRelayServerComposition({
            components: [
              { name: 'same', start: vi.fn(), stop: vi.fn() },
              { name: 'same', start: vi.fn(), stop: vi.fn() },
            ],
          }),
        ),
    ).toThrow('unique');
  });
});
