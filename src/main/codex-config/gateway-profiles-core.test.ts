import { describe, expect, it } from 'vitest';

import {
  assertCodexGatewayProfileIdCore,
  codexGatewayProfilePathCore,
  listCodexGatewayProfilesCore,
  parseCodexGatewayProfileTextCore,
  resolveCodexGatewayProfileCore,
  type CodexGatewayProfileHost,
} from './gateway-profiles-core';

const paths = { gatewaysDir: '/codex/gateways' };

function host(
  overrides: Partial<CodexGatewayProfileHost> = {},
): CodexGatewayProfileHost {
  return {
    joinPath: (directory, name) => `${directory}/${name}`,
    listDirectory: () => [],
    isFile: () => true,
    pathExists: () => true,
    readText: () => '',
    ...overrides,
  };
}

describe('Codex Gateway profile Core', () => {
  it('derives safe TOML profile paths and rejects unsafe ids', () => {
    expect(codexGatewayProfilePathCore('openrouter.team', paths, host())).toBe(
      '/codex/gateways/openrouter.team.toml',
    );
    expect(() => assertCodexGatewayProfileIdCore('../escape')).toThrow(
      /Codex Gateway profile id/,
    );
    expect(() => resolveCodexGatewayProfileCore('custom/provider', paths, host())).toThrow(
      /Codex Gateway profile id/,
    );
  });

  it('enumerates only safe .toml filename stems without parsing their contents', () => {
    const listed = listCodexGatewayProfilesCore(paths, host({
      listDirectory: () => [
        { name: 'xaminim.toml', isFile: true, isSymbolicLink: false },
        { name: 'broken.toml', isFile: true, isSymbolicLink: false },
        { name: '../escape.toml', isFile: true, isSymbolicLink: false },
        { name: 'legacy.json', isFile: true, isSymbolicLink: false },
        { name: 'directory.toml', isFile: false, isSymbolicLink: false },
      ],
      isFile: (path) => !path.endsWith('/broken.toml'),
      readText: () => { throw new Error('enumeration must not parse profiles'); },
    }));

    expect(listed).toEqual([
      { id: 'xaminim', profilePath: '/codex/gateways/xaminim.toml' },
    ]);
  });

  it('uses the filename stem as Gateway id and preserves the complete native config', () => {
    const resolved = resolveCodexGatewayProfileCore(' openrouter ', paths, host({
      readText: () => [
        'model = "vendor-model"',
        'model_provider = "internal-provider"',
        'model_reasoning_effort = "xhigh"',
        'approval_policy = "on-request"',
        'model_context_window = 1000000',
        'model_auto_compact_token_limit = 900000',
        '',
        '[model_providers.internal-provider]',
        'name = "Vendor API"',
        'base_url = "https://example.invalid/v1"',
        '',
        '[sandbox_workspace_write]',
        'network_access = true',
      ].join('\n'),
    }));

    expect(resolved).toEqual({
      id: 'openrouter',
      profilePath: '/codex/gateways/openrouter.toml',
      modelProvider: 'internal-provider',
      defaultModel: 'vendor-model',
      defaultThinking: 'xhigh',
      defaultApproval: 'on-request',
      configOverrides: {
        model: 'vendor-model',
        model_provider: 'internal-provider',
        model_reasoning_effort: 'xhigh',
        approval_policy: 'on-request',
        model_context_window: 1_000_000,
        model_auto_compact_token_limit: 900_000,
        model_providers: {
          'internal-provider': {
            name: 'Vendor API',
            base_url: 'https://example.invalid/v1',
          },
        },
        sandbox_workspace_write: { network_access: true },
      },
    });
  });

  it('allows ordinary configs without model_provider and fails closed when selected file is missing', () => {
    expect(resolveCodexGatewayProfileCore('', paths, host())).toBeNull();
    expect(parseCodexGatewayProfileTextCore('minimal', '/minimal.toml', 'model = "gpt-x"')).toEqual({
      id: 'minimal',
      profilePath: '/minimal.toml',
      configOverrides: { model: 'gpt-x' },
      defaultModel: 'gpt-x',
    });
    expect(() => resolveCodexGatewayProfileCore('missing', paths, host({
      pathExists: () => false,
    }))).toThrow(/不存在/);
    expect(() => resolveCodexGatewayProfileCore('directory', paths, host({
      isFile: () => false,
    }))).toThrow(/不是常规文件/);
  });

  it('fails closed for malformed TOML and inconsistent capacity values', () => {
    expect(() => parseCodexGatewayProfileTextCore('bad', '/bad.toml', 'model = [')).toThrow(
      /TOML 语法无效/,
    );
    expect(() => parseCodexGatewayProfileTextCore(
      'bad',
      '/bad.toml',
      'model_context_window = "1000000"',
    )).toThrow(/model_context_window 必须是正安全整数/);
    expect(() => parseCodexGatewayProfileTextCore(
      'bad',
      '/bad.toml',
      'model_context_window = 100000\nmodel_auto_compact_token_limit = 120000',
    )).toThrow(/不能大于 model_context_window/);
    expect(() => parseCodexGatewayProfileTextCore(
      'bad',
      '/bad.toml',
      '[model_providers."__proto__"]\nname = "unsafe"',
    )).toThrow(/不是安全的配置键/);
  });
});
