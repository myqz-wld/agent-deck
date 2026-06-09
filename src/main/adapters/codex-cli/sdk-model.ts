import { CODEX_DEFAULT_BUCKET } from '@shared/model-normalize';

/**
 * Convert stored/user model text into a Codex runtime model override.
 *
 * `codex-default` is a stats/UI bucket, not a real model id. Passing it to the
 * runtime breaks ChatGPT-account Codex sessions.
 */
export function toCodexModelOverride(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === CODEX_DEFAULT_BUCKET) return undefined;
  return trimmed;
}
