/**
 * Grok Build sandbox profile contract shared by main, preload, renderer, and MCP.
 *
 * Grok Build accepts both built-in profiles and names defined in user/project sandbox.toml files.
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
    throw new Error('Grok Build sandbox profile 不能为空。');
  }
  if (profile.length > MAX_GROK_SANDBOX_PROFILE_LENGTH) {
    throw new Error(
      `Grok Build sandbox profile 不能超过 ${MAX_GROK_SANDBOX_PROFILE_LENGTH} 个字符。`,
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(profile)) {
    throw new Error('Grok Build sandbox profile 不能包含控制字符。');
  }
  return profile;
}

export function isGrokBuiltinSandboxProfile(
  value: string,
): value is GrokBuiltinSandboxProfile {
  return (GROK_BUILTIN_SANDBOX_PROFILES as readonly string[]).includes(value);
}
