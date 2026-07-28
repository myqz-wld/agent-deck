export interface HookCurlCommandOptions {
  port: number;
  token: string;
  route: string;
  tag: string;
  compatibilityGuardEnvironment?: string;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function assertCommandInputs(options: HookCurlCommandOptions): void {
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65_535) {
    throw new Error('hook command requires a valid loopback port');
  }
  if (!options.token.trim()) {
    throw new Error('hook command requires a non-empty bearer token');
  }
  if (!/^\/hook\/[a-z0-9/-]+$/.test(options.route)) {
    throw new Error('hook command requires a static hook route');
  }
  if (!/^[a-z0-9-]+$/.test(options.tag)) {
    throw new Error('hook command requires a static ownership tag');
  }
  if (
    options.compatibilityGuardEnvironment &&
    !/^[A-Z][A-Z0-9_]*$/.test(options.compatibilityGuardEnvironment)
  ) {
    throw new Error('hook command requires a static compatibility guard');
  }
}

/**
 * Build a loopback hook command that reports HTTP failures without letting provider hook
 * execution fail. Response bodies/stdout are discarded, while curl's bounded stderr remains
 * visible for provider diagnostics.
 */
export function buildHookCurlCommand(options: HookCurlCommandOptions): string {
  assertCommandInputs(options);
  const endpoint = shellSingleQuote(`http://127.0.0.1:${options.port}${options.route}`);
  const authorization = shellSingleQuote(`Authorization: Bearer ${options.token}`);
  const curl = [
    'curl',
    '--silent',
    '--show-error',
    '--fail-with-body',
    '--max-time 2',
    '--request POST',
    endpoint,
    "--header 'Content-Type: application/json'",
    `--header ${authorization}`,
    '--header "X-Agent-Deck-Origin: ${AGENT_DECK_ORIGIN:-cli}"',
    '--header "X-Agent-Deck-Parent-Pid: ${PPID:-}"',
    '--data-binary @-',
    '> /dev/null',
  ].join(' ');

  const guarded = options.compatibilityGuardEnvironment
    ? `if [ -n "\${${options.compatibilityGuardEnvironment}:-}" ]; then cat > /dev/null; else ${curl}; fi`
    : curl;
  return `${guarded} || true # ${options.tag}`;
}
