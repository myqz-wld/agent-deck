export const CLI_ARGV_PAYLOAD_PREFIX = 'agent-deck-argv-b64:';

function decodePayloadToken(token: string): string[] {
  const encoded = token.slice(CLI_ARGV_PAYLOAD_PREFIX.length);
  if (!encoded) return [];
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const parts = decoded.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * macOS Electron 会把 argv 里的 `--flag value` 重排成 switches-before-positionals，
 * wrapper 因此把归一化后的 argv NUL-join 后 base64 成一个非 switch token。
 */
export function unwrapCliArgvPayload(argv: readonly string[]): string[] {
  const token = argv.find(
    (v, i) => i > 0 && argv[i - 1] === 'new' && v.startsWith(CLI_ARGV_PAYLOAD_PREFIX),
  );
  if (!token) return [...argv];
  return [argv[0] ?? '', ...decodePayloadToken(token)];
}
