import { isAbsolute } from 'node:path';

export interface HookCurlCommandOptions {
  relayConfigPath: string;
  tag: string;
  skipWhenEnvironmentSet?: string;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function assertCommandInputs(options: HookCurlCommandOptions): void {
  if (
    !isAbsolute(options.relayConfigPath) ||
    options.relayConfigPath.includes('\0') ||
    /[\r\n]/.test(options.relayConfigPath)
  ) {
    throw new Error('hook command requires an absolute private relay config path');
  }
  if (!/^[a-z0-9-]+$/.test(options.tag)) {
    throw new Error('hook command requires a static ownership tag');
  }
  if (
    options.skipWhenEnvironmentSet &&
    !/^[A-Z][A-Z0-9_]*$/.test(options.skipWhenEnvironmentSet)
  ) {
    throw new Error('hook command requires a static environment guard');
  }
}

/**
 * Build a loopback hook command that reports HTTP failures without letting provider hook
 * execution fail. Response bodies/stdout are discarded, while curl's bounded stderr remains
 * visible for provider diagnostics.
 */
export function buildHookCurlCommand(options: HookCurlCommandOptions): string {
  assertCommandInputs(options);
  const relayConfigPath = shellSingleQuote(options.relayConfigPath);
  const curl = [
    'curl',
    '--config',
    relayConfigPath,
    '--header "X-Agent-Deck-Origin: ${AGENT_DECK_ORIGIN:-cli}"',
    '--header "X-Agent-Deck-Parent-Pid: ${PPID:-}"',
    '--data-binary @-',
    '> /dev/null',
  ].join(' ');

  const guarded = options.skipWhenEnvironmentSet
    ? `if [ -n "\${${options.skipWhenEnvironmentSet}:-}" ]; then cat > /dev/null; else ${curl}; fi`
    : curl;
  return `${guarded} || true # ${options.tag}`;
}
