import type { ProviderUsageSnapshot } from '@shared/types';
import { getCodexInstance } from './codex-instance-pool';
import {
  buildCodexUsageSnapshot,
  errorUsageSnapshot,
  type CodexAccountRateLimitsResponseLike,
} from '../provider-usage';
import log from '@main/utils/logger';

const logger = log.scope('codex-usage');

export async function readCodexUsageSnapshot(): Promise<ProviderUsageSnapshot> {
  try {
    const codex = await getCodexInstance();
    const response = await codex.request<CodexAccountRateLimitsResponseLike>(
      'account/rateLimits/read',
      undefined,
    );
    return buildCodexUsageSnapshot(response);
  } catch (err) {
    logger.warn('[codex-usage] usage snapshot failed:', err);
    return errorUsageSnapshot('codex-cli', 'Codex', err);
  }
}
