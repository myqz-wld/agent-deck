import { describe, expect, it, vi } from 'vitest';

import {
  assertClaudeGatewayProfileIdCore,
  claudeGatewaySettingsPathCore,
  listClaudeGatewayProfilesCore,
  resolveClaudeGatewayProfileCore,
  type ClaudeGatewayProfileHost,
} from './gateway-profiles-core';

const paths = { gatewaysDir: '/gateways' };

function host(
  overrides: Partial<ClaudeGatewayProfileHost> = {},
): ClaudeGatewayProfileHost {
  return {
    joinPath: (directory, name) => `${directory}/${name}`,
    listDirectory: () => [],
    isFile: () => true,
    pathExists: () => true,
    readText: () => '{}',
    ...overrides,
  };
}

describe('Claude Gateway profile Core', () => {
  it('validates ids before deriving a settings path', () => {
    const gatewayHost = host();

    expect(
      claudeGatewaySettingsPathCore('deepseek-v4', paths, gatewayHost),
    ).toBe('/gateways/deepseek-v4.json');
    expect(() => assertClaudeGatewayProfileIdCore('../deepseek')).toThrow(
      /Claude 模型网关名称/,
    );
  });

  it('filters, stats, and sorts discovered JSON profiles with fail-open listing', () => {
    const isFile = vi.fn((path: string) => {
      if (path.endsWith('broken.json')) throw new Error('stat failed');
      return !path.endsWith('directory.json');
    });
    const gatewayHost = host({
      listDirectory: () => [
        { name: 'zeta.json', isFile: true, isSymbolicLink: false },
        { name: 'alpha.json', isFile: false, isSymbolicLink: true },
        { name: 'directory.json', isFile: true, isSymbolicLink: false },
        { name: 'broken.json', isFile: true, isSymbolicLink: false },
        { name: '../escape.json', isFile: true, isSymbolicLink: false },
        { name: 'ignored.txt', isFile: true, isSymbolicLink: false },
      ],
      isFile,
    });

    expect(listClaudeGatewayProfilesCore(paths, gatewayHost)).toEqual([
      { id: 'alpha', settingsPath: '/gateways/alpha.json' },
      { id: 'zeta', settingsPath: '/gateways/zeta.json' },
    ]);
    expect(
      listClaudeGatewayProfilesCore(
        paths,
        host({ listDirectory: () => { throw new Error('missing'); } }),
      ),
    ).toEqual([]);
  });

  it('projects only trimmed model metadata and applies alias fallback', () => {
    const gatewayHost = host({
      readText: () => JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: 'must-not-leak',
          CLAUDE_CONFIG_DIR: ' /config/deepseek ',
          ANTHROPIC_MODEL: ' default/model ',
          ANTHROPIC_DEFAULT_OPUS_MODEL: ' opus/model ',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 42,
        },
      }),
    });

    const resolved = resolveClaudeGatewayProfileCore(
      ' deepseek ',
      paths,
      gatewayHost,
    );
    expect(resolved).toEqual({
      id: 'deepseek',
      settingsPath: '/gateways/deepseek.json',
      configRoot: '/config/deepseek',
      defaultModel: 'default/model',
      modelAliases: {
        fable: 'default/model',
        opus: 'opus/model',
        sonnet: 'default/model',
        haiku: 'default/model',
      },
    });
    expect(JSON.stringify(resolved)).not.toContain('must-not-leak');
  });

  it('preserves null, missing-profile, and bounded JSON-object error semantics', () => {
    expect(resolveClaudeGatewayProfileCore('  ', paths, host())).toBeNull();
    expect(() =>
      resolveClaudeGatewayProfileCore(
        'missing',
        paths,
        host({ pathExists: () => false }),
      ),
    ).toThrow(/Claude 模型网关 "missing" 不存在/);
    expect(() =>
      resolveClaudeGatewayProfileCore(
        'invalid-json',
        paths,
        host({ readText: () => '[]' }),
      ),
    ).toThrow(
      /读取 Claude 模型网关配置失败（\/gateways\/invalid-json\.json）：expected a JSON object/,
    );
  });
});
