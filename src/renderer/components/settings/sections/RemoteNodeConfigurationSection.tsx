import type { JSX } from 'react';

import type { NodeConfigurationGetResult } from '@contracts/index';

import { Section, Toggle } from '../controls';

function duration(value: number): string {
  return value === 0 ? '关闭' : `${Math.round(value / 1_000)} 秒`;
}

export function RemoteNodeConfigurationSection({
  configuration,
  unavailableReason,
}: {
  configuration: NodeConfigurationGetResult | null;
  unavailableReason: string | null;
}): JSX.Element {
  const rows: ReadonlyArray<readonly [string, string]> = configuration ? [
    ['Claude Code 沙盒默认值', configuration.providerDefaults.claudeCodeSandbox],
    ['Codex CLI 沙盒默认值', configuration.providerDefaults.codexSandbox],
    ['Grok Build 沙盒默认值', configuration.providerDefaults.grokSandbox],
    ['权限等待超时', duration(configuration.providerDefaults.permissionTimeoutMs)],
    ['总结模型', configuration.providerDefaults.summaryModel || '跟随运行时默认'],
    ['总结思考档位', configuration.providerDefaults.summaryThinking || '跟随运行时默认'],
    ['总结超时', duration(configuration.providerDefaults.summaryTimeoutMs)],
  ] : [];
  return (
    <Section title="Worker 配置（只读）" storageKey="remote-node-configuration">
      <p className="text-[10px] leading-relaxed text-deck-muted/75">
        以下配置来自当前 Worker 的部署快照。Remote 中仅供查看；如需调整，请更新 Worker 部署后重新启动。
      </p>
      {unavailableReason ? (
        <div role="status" className="text-[11px] text-deck-muted">{unavailableReason}</div>
      ) : configuration ? (
        <div className="flex flex-col gap-1.5 opacity-70">
          <Toggle
            label="启用 Agent Deck MCP"
            value={configuration.providerDefaults.enableAgentDeckMcp}
            onChange={() => undefined}
            disabled
          />
          {rows.map(([label, value]) => (
            <label key={label} className="flex items-center justify-between gap-2 text-[11px] text-deck-muted/70">
              <span className="min-w-0 flex-1">{label}</span>
              <input
                type="text"
                value={value}
                disabled
                aria-label={`${label}（只读）`}
                className="w-36 rounded border border-deck-border bg-white/[0.04] px-2 py-0.5 text-right text-[10px] text-deck-muted disabled:cursor-not-allowed disabled:opacity-70"
              />
            </label>
          ))}
          <div className="flex items-start justify-between gap-3 border-t border-deck-border/60 pt-1.5 text-[10px]">
            <span className="text-deck-muted">部署快照版本</span>
            <span className="text-deck-muted/80">{configuration.revision}</span>
          </div>
        </div>
      ) : (
        <div className="text-[11px] text-deck-muted">正在读取 Worker 配置…</div>
      )}
    </Section>
  );
}
