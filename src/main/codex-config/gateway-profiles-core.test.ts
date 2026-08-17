import { describe, expect, it } from 'vitest';

import {
  assertCodexGatewayProfileIdCore,
  codexGatewayProfilePathCore,
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
    isFile: () => true,
    pathExists: () => true,
    readText: () => '{}',
    ...overrides,
  };
}

describe('Codex Gateway profile Core', () => {
  it('derives safe provider profile paths without narrowing native provider support', () => {
    expect(codexGatewayProfilePathCore('openrouter.team', paths, host())).toBe(
      '/codex/gateways/openrouter.team.json',
    );
    expect(() => assertCodexGatewayProfileIdCore('../escape')).toThrow(
      /Codex Gateway profile id/,
    );
    expect(resolveCodexGatewayProfileCore('custom/provider', paths, host())).toBeNull();
  });

  it('projects context and compaction values while ignoring unrelated metadata', () => {
    const resolved = resolveCodexGatewayProfileCore(' openrouter ', paths, host({
      readText: () => JSON.stringify({
        name: 'OpenRouter large context',
        api_key: 'must-not-leak',
        model_context_window: 1_000_000,
        model_auto_compact_token_limit: 900_000,
      }),
    }));

    expect(resolved).toEqual({
      id: 'openrouter',
      profilePath: '/codex/gateways/openrouter.json',
      configOverrides: {
        model_context_window: 1_000_000,
        model_auto_compact_token_limit: 900_000,
      },
    });
    expect(JSON.stringify(resolved)).not.toContain('must-not-leak');
  });

  it('keeps missing profiles optional and rejects unsafe existing targets', () => {
    expect(resolveCodexGatewayProfileCore('', paths, host())).toBeNull();
    expect(resolveCodexGatewayProfileCore('missing', paths, host({
      pathExists: () => false,
    }))).toBeNull();
    expect(() => resolveCodexGatewayProfileCore('directory', paths, host({
      isFile: () => false,
    }))).toThrow(/不是常规文件/);
  });

  it('fails closed for malformed or inconsistent supported values', () => {
    expect(() => parseCodexGatewayProfileTextCore('bad', '/bad.json', '[]')).toThrow(
      /JSON 根节点必须是 object/,
    );
    expect(() => parseCodexGatewayProfileTextCore(
      'bad',
      '/bad.json',
      '{"model_context_window":"1000000"}',
    )).toThrow(/model_context_window 必须是正安全整数/);
    expect(() => parseCodexGatewayProfileTextCore(
      'bad',
      '/bad.json',
      JSON.stringify({
        model_context_window: 100_000,
        model_auto_compact_token_limit: 120_000,
      }),
    )).toThrow(/不能大于 model_context_window/);
  });
});
