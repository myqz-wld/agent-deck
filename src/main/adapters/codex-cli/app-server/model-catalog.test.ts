import { describe, expect, it } from 'vitest';
import TOML from '@iarna/toml';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import { codexModelCatalogArguments, resolveCodexModelCatalogPath } from './model-catalog';
import { withGatewayOptions, type CodexThreadMode } from './thread-mode';

describe('native Codex startup model catalog', () => {
  it('preserves native defaults and later-layer precedence without promoting unrelated settings', () => {
    expect(codexModelCatalogArguments(undefined)).toEqual([]);
    expect(resolveCodexModelCatalogPath(undefined, { model: 'alias', features: { tool_search: false } }))
      .toBeUndefined();
    expect(resolveCodexModelCatalogPath(
      { model_catalog_json: '/provider/gateway.json', mcp_servers: { untrusted: { command: 'bad' } } },
      { model_catalog_json: '/provider/agent.json' },
    )).toBe('/provider/agent.json');
  });

  it.each([null, false, 1, [], {}, '', ' ', 'relative.json', '~/models.json', '/bad\0path'])(
    'rejects invalid owning-host paths without echoing the value: %j', (value) => {
      expect(() => resolveCodexModelCatalogPath({ model_catalog_json: value } as CodexConfigObject))
        .toThrow('model_catalog_json 必须是运行主机上的绝对文件路径');
    },
  );

  it('keeps quotes, spaces, and shell syntax in one literal TOML argv value', () => {
    const path = '/private/models/a "quoted" $(no-execution) `literal`.json';
    const args = codexModelCatalogArguments(path);
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('-c');
    expect(TOML.parse(args[1])).toEqual({ model_catalog_json: path });
  });

  const mode: CodexThreadMode = { mode: 'start', options: {
    workingDirectory: '/repo', sandboxMode: 'read-only', skipGitRepoCheck: true,
    gatewayConfigOverrides: { model_catalog_json: '/provider/a.json' },
  } };
  const selection = (path?: string) => ({
    gatewayConfigOverrides: path ? { model_catalog_json: path } : null,
    modelProvider: 'next', model: null, effort: null,
  });

  it('rejects adding, changing, or removing the catalog before mutating a staged Gateway', () => {
    for (const path of [undefined, '/provider/b.json']) {
      expect(() => withGatewayOptions(mode, selection(path))).toThrow('请新建会话');
      expect(mode.options.gatewayConfigOverrides?.model_catalog_json).toBe('/provider/a.json');
    }
    expect(() => withGatewayOptions({ ...mode, options: { ...mode.options, gatewayConfigOverrides: undefined } },
      selection('/provider/a.json'))).toThrow('请新建会话');
  });

  it('allows same-catalog switches and respects an Agent layer that owns the catalog', () => {
    expect(withGatewayOptions(mode, selection('/provider/a.json')).options.modelProvider).toBe('next');
    const agentMode = { ...mode, options: { ...mode.options,
      configOverrides: { model_catalog_json: '/provider/agent.json' },
    } };
    expect(withGatewayOptions(agentMode, selection('/provider/b.json')).options.modelProvider).toBe('next');
  });
});
