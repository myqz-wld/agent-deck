import { isJsonObject, type JsonObject } from '@contracts/index';
import { DEFAULT_SETTINGS } from '@shared/types/settings/defaults';

export interface ServerCoreSessionLifecycleSettings {
  activeWindowMs: number;
  closeAfterMs: number;
  historyRetentionDays: number;
  issueResolvedRetentionDays: number;
  issueSoftDeletedRetentionDays: number;
  messageRetentionDays: number;
}

const MAX_WINDOW_MS = 365 * 24 * 60 * 60 * 1_000;
const MAX_RETENTION_DAYS = 3_650;

function positiveInteger(value: unknown, field: string, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > max) {
    throw new Error(`runtimeOptions.sessionLifecycle.${field} is invalid`);
  }
  return Number(value);
}

function retentionDays(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > MAX_RETENTION_DAYS) {
    throw new Error(`runtimeOptions.sessionLifecycle.${field} is invalid`);
  }
  return Number(value);
}

export function resolveServerCoreSessionLifecycleSettings(
  runtimeOptions: JsonObject,
): ServerCoreSessionLifecycleSettings {
  const value = runtimeOptions.sessionLifecycle;
  if (value === undefined) {
    return Object.freeze({
      activeWindowMs: DEFAULT_SETTINGS.activeWindowMs,
      closeAfterMs: DEFAULT_SETTINGS.closeAfterMs,
      historyRetentionDays: DEFAULT_SETTINGS.historyRetentionDays,
      issueResolvedRetentionDays: DEFAULT_SETTINGS.issueResolvedRetentionDays,
      issueSoftDeletedRetentionDays: DEFAULT_SETTINGS.issueSoftDeletedRetentionDays,
      messageRetentionDays: DEFAULT_SETTINGS.messageRetentionDays,
    });
  }
  if (!isJsonObject(value)) {
    throw new Error('runtimeOptions.sessionLifecycle must be an object');
  }
  const keys = Object.keys(value).sort();
  const expected = [
    'activeWindowMs',
    'closeAfterMs',
    'historyRetentionDays',
    'issueResolvedRetentionDays',
    'issueSoftDeletedRetentionDays',
    'messageRetentionDays',
    'schemaVersion',
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error('runtimeOptions.sessionLifecycle has unsupported fields');
  }
  if (value.schemaVersion !== 1) {
    throw new Error('runtimeOptions.sessionLifecycle.schemaVersion must be 1');
  }
  const settings = {
    activeWindowMs: positiveInteger(value.activeWindowMs, 'activeWindowMs', MAX_WINDOW_MS),
    closeAfterMs: positiveInteger(value.closeAfterMs, 'closeAfterMs', MAX_WINDOW_MS),
    historyRetentionDays: retentionDays(value.historyRetentionDays, 'historyRetentionDays'),
    issueResolvedRetentionDays: retentionDays(
      value.issueResolvedRetentionDays,
      'issueResolvedRetentionDays',
    ),
    issueSoftDeletedRetentionDays: retentionDays(
      value.issueSoftDeletedRetentionDays,
      'issueSoftDeletedRetentionDays',
    ),
    messageRetentionDays: retentionDays(value.messageRetentionDays, 'messageRetentionDays'),
  };
  if (settings.closeAfterMs <= settings.activeWindowMs) {
    throw new Error('runtimeOptions.sessionLifecycle.closeAfterMs must exceed activeWindowMs');
  }
  return Object.freeze(settings);
}
