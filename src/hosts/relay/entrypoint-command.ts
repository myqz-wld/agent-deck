import { parseExactFlags } from '@hosts/linux-runtime/validation';

export const RELAY_FORCED_COMMAND_FLAGS = Object.freeze({
  attach: Object.freeze([
    '--instance',
    '--credential',
    '--socket',
    '--worker',
  ]),
  bridge: Object.freeze([
    '--instance',
    '--credential',
    '--surface',
    '--socket',
  ]),
});

export interface ParsedRelayForcedCommand {
  readonly role: 'client' | 'worker';
  readonly flags: Readonly<Record<string, string>>;
}

/** The packaged authorized-key fixtures and the production entrypoint share this parser. */
export function parseRelayForcedCommand(
  argv: readonly string[],
): ParsedRelayForcedCommand | null {
  if (argv[0] === 'attach') {
    return Object.freeze({
      role: 'worker' as const,
      flags: parseExactFlags(argv.slice(1), RELAY_FORCED_COMMAND_FLAGS.attach),
    });
  }
  if (argv[0] === 'bridge') {
    return Object.freeze({
      role: 'client' as const,
      flags: parseExactFlags(argv.slice(1), RELAY_FORCED_COMMAND_FLAGS.bridge),
    });
  }
  return null;
}
