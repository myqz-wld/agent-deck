import { isAbsolute } from 'node:path';
import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';

/** Select only the native startup-only catalog; later layers win like thread configuration. */
export function resolveCodexModelCatalogPath(
  ...layers: Array<CodexConfigObject | null | undefined>
): string | undefined {
  let selected: unknown;
  for (const layer of layers) {
    if (layer?.model_catalog_json !== undefined) selected = layer.model_catalog_json;
  }
  if (selected === undefined) return undefined;
  if (typeof selected !== 'string' || !selected.trim() || selected.includes('\0') || !isAbsolute(selected)) {
    throw new Error('Codex model_catalog_json 必须是运行主机上的绝对文件路径。请修正模型网关或 Agent 配置后重试。');
  }
  return selected;
}

/** argv values are TOML strings, passed directly to spawn without a shell. */
export function codexModelCatalogArguments(path: string | undefined): string[] {
  const selected = path === undefined ? undefined : resolveCodexModelCatalogPath({ model_catalog_json: path });
  return selected === undefined ? [] : ['-c', `model_catalog_json=${JSON.stringify(selected)}`];
}

export function assertCodexModelCatalogUnchanged(
  current: string | undefined,
  requested: string | undefined,
): void {
  if (current !== requested) {
    throw new Error('Codex 模型目录仅在运行实例启动时加载。请新建会话以应用此模型网关；当前会话保持原配置。');
  }
}
