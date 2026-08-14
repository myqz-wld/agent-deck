import {
  FeishuGatewayError,
  type FeishuGatewayClock,
} from '@gateways/im';

type Timer = ReturnType<FeishuGatewayClock['setTimer']>;

export function boundedFeishuOperation<T>(
  promise: Promise<T>,
  clock: FeishuGatewayClock,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: Timer | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = clock.setTimer(
      () => reject(new FeishuGatewayError('lifecycle_failed', message, true)),
      timeoutMs,
    );
  });
  return Promise.race([promise, deadline]).finally(() => timer?.cancel());
}
