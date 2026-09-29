import { setTimeout as delay } from 'node:timers/promises';

/** Type=simple becomes active before the gateway has opened its management socket. */
export async function waitForFeishuStartup<T>(
  probe: () => Promise<T>,
  timeoutMs = 20_000,
  retryMs = 100,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try { return await probe(); } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      // Never retry identity, permission, protocol or policy failures as startup transients.
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error('Feishu management readiness timed out', { cause: error });
      await delay(Math.min(retryMs, remaining));
    }
  }
}
