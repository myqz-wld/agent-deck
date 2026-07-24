import type { AppSettings } from '@shared/types';

export const SUMMARY_PROVIDER_CAPABILITY_UNAVAILABLE =
  'SUMMARY_PROVIDER_CAPABILITY_UNAVAILABLE' as const;

/**
 * A provider cannot safely run periodic summaries for the lifetime of this app build.
 *
 * Unlike authentication, timeout, or model errors, retrying this condition per session cannot
 * succeed. The scheduler opens a process-lifetime circuit and keeps using its local fallback until
 * a newly installed build restarts the application and can attest the provider again.
 */
export class SummaryProviderCapabilityError extends Error {
  readonly code = SUMMARY_PROVIDER_CAPABILITY_UNAVAILABLE;

  constructor(
    readonly provider: AppSettings['summaryAdapter'],
    readonly reason: string,
  ) {
    super(`__${provider}_summarizer_tools_unproven__: ${reason}`);
    this.name = 'SummaryProviderCapabilityError';
  }
}

export function isSummaryProviderCapabilityError(
  error: unknown,
): error is SummaryProviderCapabilityError {
  const validProvider =
    typeof error === 'object' &&
    error !== null &&
    'provider' in error &&
    (error.provider === 'claude-code' ||
      error.provider === 'codex-cli' ||
      error.provider === 'grok-build');
  return (
    error instanceof SummaryProviderCapabilityError ||
    (typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === SUMMARY_PROVIDER_CAPABILITY_UNAVAILABLE &&
      validProvider &&
      'message' in error &&
      typeof error.message === 'string')
  );
}
