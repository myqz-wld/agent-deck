import { describe, expect, it } from 'vitest';
import { buildGrokLaunchSpec } from '../launch-child';

describe('Grok login-shell launch', () => {
  it('passes the binary and args positionally and reserves fd 3 for ACP output', () => {
    expect(
      buildGrokLaunchSpec('/Applications/Grok Build/grok', [
        'agent',
        '--no-leader',
        'stdio',
      ], {
        platform: 'darwin',
        shell: '/bin/zsh',
      }),
    ).toEqual({
      command: '/bin/zsh',
      args: [
        '-ilc',
        'exec "$@" 1>&3',
        'agent-deck-grok',
        '/Applications/Grok Build/grok',
        'agent',
        '--no-leader',
        'stdio',
      ],
      useLoginShell: true,
    });
  });

  it('keeps deterministic test args and unsupported shells on direct spawn', () => {
    expect(
      buildGrokLaunchSpec('node', ['fixture.mjs'], {
        platform: 'darwin',
        shell: '/bin/zsh',
        explicitTestArgs: true,
      }),
    ).toEqual({
      command: 'node',
      args: ['fixture.mjs'],
      useLoginShell: false,
    });
    expect(
      buildGrokLaunchSpec('grok', ['agent', 'stdio'], {
        platform: 'darwin',
        shell: '/opt/homebrew/bin/fish',
      }).useLoginShell,
    ).toBe(false);
  });
});
