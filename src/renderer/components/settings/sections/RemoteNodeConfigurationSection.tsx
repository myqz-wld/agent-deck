import { Fragment, type JSX } from 'react';

import type { NodeConfigurationGetResult } from '@contracts/index';

import { Section, Toggle } from '../controls';

function duration(value: number): string {
  return value === 0 ? '关闭' : `${Math.round(value / 1_000)} 秒`;
}

type RemoteConfigurationGroup = 'session' | 'runtime' | 'mcp';

interface Props {
  configuration: NodeConfigurationGetResult | null;
  group: RemoteConfigurationGroup;
}

function ReadOnlyRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <label className="flex items-center justify-between gap-2 text-[11px] text-deck-muted/70">
      <span className="min-w-0 flex-1">{label}</span>
      <input
        type="text"
        value={value}
        disabled
        aria-label={label}
        className="w-28 rounded border border-deck-border bg-white/[0.04] px-2 py-0.5 text-right text-[11px] text-deck-muted disabled:cursor-not-allowed disabled:opacity-70"
      />
    </label>
  );
}

function ReadOnlyChoice({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-deck-muted/70">
      <span>{label}</span>
      <input
        type="text"
        value={value}
        disabled
        aria-label={label}
        className="w-full rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-left text-[11px] text-deck-muted disabled:cursor-not-allowed disabled:opacity-70"
      />
    </label>
  );
}

function placeholder(value: string | undefined, fallback = '—'): string {
  return value === undefined ? '—' : value || fallback;
}

export function RemoteNodeConfigurationSection({
  configuration,
  group,
}: Props): JSX.Element {
  const defaults = configuration?.providerDefaults;

  if (group === 'session') {
    return (
      <Fragment>
        <Section title="生命周期" storageKey="lifecycle" defaultOpen>
          <ReadOnlyRow
            label="待处理请求超时"
            value={defaults ? duration(defaults.permissionTimeoutMs) : '—'}
          />
        </Section>
        <Section title="会话续接上下文" storageKey="continuation-context" defaultOpen={false}>
          <p className="text-[10px] leading-snug text-deck-muted/70">
            当前远端环境没有可显示的此类设置。
          </p>
        </Section>
        <Section title="间歇总结" storageKey="summary" defaultOpen={false}>
          <ReadOnlyChoice
            label="总结模型"
            value={placeholder(defaults?.summaryModel, '跟随默认设置')}
          />
          <ReadOnlyRow
            label="思考档位"
            value={placeholder(defaults?.summaryThinking, '跟随默认设置')}
          />
          <ReadOnlyRow
            label="总结超时"
            value={defaults ? duration(defaults.summaryTimeoutMs) : '—'}
          />
        </Section>
      </Fragment>
    );
  }

  if (group === 'runtime') {
    return (
      <Fragment>
        <Section title="Hook Server（本地端口）" storageKey="hookserver" defaultOpen={false}>
          <p className="text-[10px] leading-snug text-deck-muted/70">
            远端连接由系统自动管理。
          </p>
        </Section>
        <Section title="外部工具" storageKey="external" defaultOpen={false}>
          <p className="text-[10px] leading-snug text-deck-muted/70">
            命令位置由远端环境管理，不在这里显示。
          </p>
        </Section>
        <Section title="实验功能" storageKey="experimental" defaultOpen={false}>
          <ReadOnlyChoice
            label="Claude Code 沙盒（系统隔离）"
            value={placeholder(defaults?.claudeCodeSandbox)}
          />
          <ReadOnlyChoice
            label="Codex CLI 沙盒（系统隔离）"
            value={placeholder(defaults?.codexSandbox)}
          />
          <ReadOnlyChoice
            label="Grok Build 沙盒（请求档位）"
            value={placeholder(defaults?.grokSandbox)}
          />
        </Section>
      </Fragment>
    );
  }

  return (
    <Section title="Agent Deck MCP" storageKey="agent-deck-mcp" defaultOpen={false}>
      <Toggle
        label="启用 Agent Deck MCP"
        value={defaults?.enableAgentDeckMcp ?? false}
        onChange={() => undefined}
        disabled
      />
    </Section>
  );
}
