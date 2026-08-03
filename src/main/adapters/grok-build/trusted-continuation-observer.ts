import type { GrokRuntime } from './runtime-types';

export function observeGrokTrustedContinuationFinished(
  runtime: GrokRuntime | undefined,
  payload: unknown,
): void {
  const acceptance = runtime?.trustedContinuationAcceptance;
  if (!acceptance) return;
  delete runtime.trustedContinuationAcceptance;
  const result = record(payload);
  if (result?.ok === true) {
    acceptance.acceptModelActivity();
    return;
  }
  acceptance.reject(
    result?.failureReason === 'context-window-exceeded'
      ? 'context-window-exceeded'
      : 'provider-error',
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
