import { describe, expect, it } from 'vitest';

import {
  parseProviderSessionShimArgs,
  providerSessionGrokConfig,
  providerSessionGrokLaunchSpec,
} from './shim-entrypoint';

describe('provider session shim entrypoint', () => {
  it('accepts only one fixed adapter and one bounded effective access value', () => {
    expect(parseProviderSessionShimArgs([
      '--adapter', 'grok-build', '--access', 'selected-directory-read-write',
      '--project-trusted', 'false',
    ])).toEqual({
      adapter: 'grok-build',
      access: 'selected-directory-read-write',
      projectTrusted: false,
    });
    for (const argv of [
      ['--adapter', 'codex-cli', '--access', 'workspace-read-only'],
      ['--adapter', 'grok-build', '--access', 'danger-full-access'],
      ['--adapter', 'grok-build', '--access', 'workspace-read-only', '--credential', 'secret'],
    ]) expect(() => parseProviderSessionShimArgs(argv)).toThrow('argv');
  });

  it('maps the outer ceiling to native profiles with only a non-secret broker marker', () => {
    const expected = new Map([
      ['provider-strict', 'strict'],
      ['selected-directory-read-write', 'workspace'],
      ['workspace-read-only', 'read-only'],
      ['workspace-read-write', 'off'],
    ] as const);
    for (const [access, profile] of expected) {
      const parsed = parseProviderSessionShimArgs([
        '--adapter', 'grok-build', '--access', access,
        '--project-trusted', 'false',
      ]);
      const launch = providerSessionGrokLaunchSpec(
        parsed,
        'http://127.0.0.1:43121/v1',
        '/workspace/repo',
      );
      expect(launch.args).toEqual(['--sandbox', profile, 'agent', '--no-leader', 'stdio']);
      expect(launch.binary).toBe('/opt/agent-deck/providers/grok/grok');
      expect(launch.environment).toMatchObject({
        GROK_CLI_CHAT_PROXY_BASE_URL: 'http://127.0.0.1:43121/v1',
        GROK_XAI_API_BASE_URL: 'http://127.0.0.1:43121/v1',
        GROK_HOME: '/state/home/.grok',
        HOME: '/state/home',
        XAI_API_KEY: 'agent-deck-session-broker',
      });
      expect(JSON.stringify(launch)).not.toMatch(
        /docker\.sock|podman\.sock|ssh|reusable|xai-[A-Za-z0-9]/i,
      );
    }
    expect(() => providerSessionGrokLaunchSpec(
      parseProviderSessionShimArgs([
        '--adapter', 'grok-build', '--access', 'workspace-read-only',
        '--project-trusted', 'false',
      ]),
      'https://cli-chat-proxy.grok.com/v1',
      '/workspace',
    )).toThrow('projection');
  });

  it('uses the OCI mount ceiling on Desktop without granting nested namespace capabilities', () => {
    for (const access of [
      'provider-strict',
      'selected-directory-read-write',
      'workspace-read-only',
      'workspace-read-write',
    ] as const) {
      const launch = providerSessionGrokLaunchSpec(
        { adapter: 'grok-build', access, projectTrusted: false },
        'http://127.0.0.1:43121/v1',
        '/workspace',
        '/opt/agent-deck/providers/grok/grok',
        false,
      );
      expect(launch.args.slice(0, 2)).toEqual(['--sandbox', 'off']);
    }
  });

  it('projects only a persisted Core trust verdict into native Grok argv', () => {
    const launch = providerSessionGrokLaunchSpec(
      {
        adapter: 'grok-build',
        access: 'selected-directory-read-write',
        projectTrusted: true,
      },
      'http://127.0.0.1:43121/v1',
      '/workspace/repo',
    );
    expect(launch.args).toEqual([
      '--trust', '--sandbox', 'workspace', 'agent', '--no-leader', 'stdio',
    ]);
  });

  it('prepends only the fixed Browser shim directory to the Grok child PATH', () => {
    const args = {
      adapter: 'grok-build' as const,
      access: 'workspace-read-only' as const,
      projectTrusted: false,
    };
    const browserEnvironment = {
      PATH: '/state/home/.agent-deck/browser/bin:/opt/agent-deck/providers/grok:/usr/bin:/bin',
    };
    expect(providerSessionGrokLaunchSpec(
      args,
      'http://127.0.0.1:43121/v1',
      '/workspace',
      '/opt/agent-deck/providers/grok/grok',
      true,
      browserEnvironment,
    ).environment.PATH).toBe(browserEnvironment.PATH);
    expect(() => providerSessionGrokLaunchSpec(
      args,
      'http://127.0.0.1:43121/v1',
      '/workspace',
      '/opt/agent-deck/providers/grok/grok',
      true,
      { PATH: '/tmp/untrusted' },
    )).toThrow('projection');
  });

  it('pins Grok 4.5 to the single broker-authorized Chat Completions route', () => {
    const config = providerSessionGrokConfig('http://127.0.0.1:43121/v1');
    expect(config).toContain('model = "grok-4.6"');
    expect(config).toContain('name = "Grok 4.6"');
    expect(config).toContain('api_backend = "chat_completions"');
    expect(config).toContain('base_url = "http://127.0.0.1:43121/v1"');
    expect(config).not.toMatch(/auth\.json|bearer|credential|xai-[A-Za-z0-9]/i);
  });
});
