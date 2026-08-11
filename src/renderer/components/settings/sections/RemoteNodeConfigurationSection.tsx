import type { JSX } from 'react';

import type { NodeConfigurationGetResult } from '@contracts/index';

import { Section } from '../controls';

function bool(value: boolean): string {
  return value ? '启用' : '关闭';
}

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
    ['Agent Deck MCP', bool(configuration.providerDefaults.enableAgentDeckMcp)],
    ['权限等待超时', duration(configuration.providerDefaults.permissionTimeoutMs)],
    ['总结模型', configuration.providerDefaults.summaryModel || '跟随运行时默认'],
    ['总结思考档位', configuration.providerDefaults.summaryThinking || '跟随运行时默认'],
    ['总结超时', duration(configuration.providerDefaults.summaryTimeoutMs)],
  ] : [];
  return (
    <Section title="远端执行节点" storageKey="remote-node-configuration">
      <p className="text-[10px] leading-relaxed text-deck-muted/75">
        以下值来自当前 Remote Worker 的 Server Core，不读取本机 Provider 设置。部署参数为只读；修改后需通过受控部署更新 Worker。
      </p>
      {unavailableReason ? (
        <div role="status" className="text-[11px] text-deck-muted">{unavailableReason}</div>
      ) : configuration ? (
        <dl className="space-y-1.5 text-[10px]">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-start justify-between gap-3">
              <dt className="text-deck-muted">{label}</dt>
              <dd className="min-w-0 break-all text-right text-deck-text">{value}</dd>
            </div>
          ))}
          <div className="flex items-start justify-between gap-3 border-t border-deck-border/60 pt-1.5">
            <dt className="text-deck-muted">配置 revision</dt>
            <dd className="text-deck-text">{configuration.revision}</dd>
          </div>
        </dl>
      ) : (
        <div className="text-[11px] text-deck-muted">正在读取 Worker 配置…</div>
      )}
    </Section>
  );
}
