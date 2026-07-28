/**
 * Grok Build sandbox profile contract shared by main, preload, renderer, and MCP.
 *
 * Grok accepts both built-in profiles and names defined in user/project sandbox.toml files.
 * Keep the public type open while enforcing one boundary rule everywhere.
 */
export const GROK_BUILTIN_SANDBOX_PROFILES = [
  'off',
  'workspace',
  'devbox',
  'read-only',
  'strict',
] as const;

export type GrokBuiltinSandboxProfile =
  (typeof GROK_BUILTIN_SANDBOX_PROFILES)[number];
export type GrokSandboxProfile = string;

export const MAX_GROK_SANDBOX_PROFILE_LENGTH = 128;

export function normalizeGrokSandboxProfile(value: string): GrokSandboxProfile {
  const profile = value.trim();
  if (profile.length === 0) {
    throw new Error('Grok sandbox profile must not be empty.');
  }
  if (profile.length > MAX_GROK_SANDBOX_PROFILE_LENGTH) {
    throw new Error(
      `Grok sandbox profile must not exceed ${MAX_GROK_SANDBOX_PROFILE_LENGTH} characters.`,
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(profile)) {
    throw new Error('Grok sandbox profile must not contain control characters.');
  }
  return profile;
}

export function isGrokBuiltinSandboxProfile(
  value: string,
): value is GrokBuiltinSandboxProfile {
  return (GROK_BUILTIN_SANDBOX_PROFILES as readonly string[]).includes(value);
}
