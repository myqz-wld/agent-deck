const MAX_DIAGNOSTIC_COUNT = 10_000;
export type ClaudeSettingsEnvState = 'healthy' | 'rejected-keys' | 'read-failed';

export interface ClaudeSettingsEnvHost {
  resolveSettingsPath(): string;
  settingsFileExists(path: string): boolean;
  readSettingsText(path: string): string;
  assignEnv(key: string, value: string): void;
  observeState(state: ClaudeSettingsEnvState, appliedCount: number, rejectedCount: number): void;
}

function observeSettingsEnvState(
  host: ClaudeSettingsEnvHost,
  state: ClaudeSettingsEnvState,
  appliedCount: number,
  rejectedCount: number,
): void {
  try {
    host.observeState(
      state,
      boundedCount(appliedCount),
      boundedCount(rejectedCount),
    );
  } catch {
    // Diagnostics cannot alter environment assignments or the existing fallback.
  }
}

function boundedCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(MAX_DIAGNOSTIC_COUNT, Math.floor(value));
}

const ALLOWED_PREFIXES = ['ANTHROPIC_', 'CLAUDE_'];
const ALLOWED_KEYS = new Set<string>([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
]);

function isAllowed(key: string): boolean {
  if (ALLOWED_KEYS.has(key)) return true;
  return ALLOWED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function readEnvObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const env = (value as Record<string, unknown>).env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null;
  return env as Record<string, unknown>;
}

/**
 * Apply the allowlisted environment from the user settings file in source order. Unknown keys are
 * skipped, non-string values are ignored, and read or assignment failures retain the existing
 * best-effort return behavior.
 */
export function applyClaudeSettingsEnvCore(host: ClaudeSettingsEnvHost): void {
  const settingsPath = host.resolveSettingsPath();
  if (!host.settingsFileExists(settingsPath)) {
    observeSettingsEnvState(host, 'healthy', 0, 0);
    return;
  }

  let appliedCount = 0;
  let rejectedCount = 0;
  try {
    const raw = host.readSettingsText(settingsPath);
    const env = readEnvObject(JSON.parse(raw));
    if (env) {
      for (const [key, value] of Object.entries(env)) {
        if (typeof value !== 'string') continue;
        if (!isAllowed(key)) {
          rejectedCount += 1;
          continue;
        }
        host.assignEnv(key, value);
        appliedCount += 1;
      }
    }
    observeSettingsEnvState(
      host,
      rejectedCount > 0 ? 'rejected-keys' : 'healthy',
      appliedCount,
      rejectedCount,
    );
  } catch {
    observeSettingsEnvState(host, 'read-failed', appliedCount, rejectedCount);
  }
}
