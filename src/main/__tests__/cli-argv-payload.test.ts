import { describe, expect, it } from 'vitest';

import { CLI_ARGV_PAYLOAD_PREFIX, unwrapCliArgvPayload } from '@main/cli-argv-payload';

function payload(args: readonly string[]): string {
  return CLI_ARGV_PAYLOAD_PREFIX + Buffer.from(`${args.join('\0')}\0`, 'utf8').toString('base64');
}

describe('CLI argv payload unwrap', () => {
  it('restores wrapper argv after Electron reorders switches before positionals', () => {
    const original = [
      'new',
      '--cwd',
      '/tmp',
      '--prompt',
      'debug-probe',
      '--permission-mode',
      'acceptEdits',
      '--no-focus',
    ];
    const electronCommandLine = [
      '/Applications/Agent Deck.app/Contents/MacOS/Agent Deck',
      '--allow-file-access-from-files',
      '--enable-avfoundation',
      'new',
      payload(original),
    ];

    expect(unwrapCliArgvPayload(electronCommandLine)).toEqual([
      '/Applications/Agent Deck.app/Contents/MacOS/Agent Deck',
      ...original,
    ]);
  });

  it('leaves normal argv unchanged when no payload token exists', () => {
    const argv = ['Agent Deck', 'new', '--cwd', '/tmp'];
    expect(unwrapCliArgvPayload(argv)).toEqual(argv);
  });

  it('does not treat a prompt value as internal payload', () => {
    const argv = ['Agent Deck', 'new', '--prompt', payload(['new', '--cwd', '/tmp'])];
    expect(unwrapCliArgvPayload(argv)).toEqual(argv);
  });
});
