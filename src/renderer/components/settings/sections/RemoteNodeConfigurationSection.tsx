import { Fragment, type JSX } from 'react';

import type { NodeConfigurationGetResult } from '@contracts/index';
import {
  CLAUDE_SANDBOX_OPTIONS,
  CODEX_SANDBOX_OPTIONS,
  GROK_SANDBOX_MODE_OPTIONS,
} from '@renderer/lib/sandbox-options';

import { Section, Toggle } from '../controls';

function duration(value: number, zeroLabel = '0 秒'): string {
  if (value === 0) return zeroLabel;
  const units = [
    ['小时', 3_600_000],
    ['分钟', 60_000],
    ['秒', 1_000],
    ['毫秒', 1],
  ] as const;
  let remaining = value;
  const parts: string[] = [];
  for (const [label, size] of units) {
    const count = Math.floor(remaining / size);
    if (count > 0) parts.push(`${count} ${label}`);
    remaining %= size;
  }
  return parts.join(' ');
}

function days(value: number): string {
  return value === 0 ? '永久保留' : `${value} 天`;
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

function ReadOnlyToggle({
  label,
  value,
}: {
  label: string;
  value: boolean | undefined;
}): JSX.Element {
  return value === undefined ? (
    <ReadOnlyRow label={label} value="—" />
  ) : (
    <Toggle label={label} value={value} onChange={() => undefined} disabled />
  );
}

function placeholder(value: string | undefined, fallback = '—'): string {
  return value === undefined ? '—' : value || fallback;
}

function executable(value: string | null | undefined): string {
  if (value === undefined) return '—';
  return value ?? '使用内置版本';
}

function sandbox(adapter: 'claude' | 'codex' | 'grok', value: string | undefined): string {
  if (value === undefined) return '—';
  const options = adapter === 'claude'
    ? CLAUDE_SANDBOX_OPTIONS
    : adapter === 'codex' ? CODEX_SANDBOX_OPTIONS : GROK_SANDBOX_MODE_OPTIONS;
  const builtIn = options.find((option) => option.value === value);
  if (builtIn) return builtIn.label;
  return adapter === 'grok' ? `自定义：${value}` : value;
}

function thinking(value: string | undefined): string {
  const labels: Record<string, string> = {
    none: '关闭', minimal: '最少', low: '低', medium: '中', high: '高',
    xhigh: '很高', max: '最高', ultra: '极高',
  };
  return value === undefined ? '—' : labels[value] ?? value;
}

export function RemoteNodeConfigurationSection({
  configuration,
  group,
}: Props): JSX.Element {
  const defaults = configuration?.providerDefaults;
  const lifecycle = configuration?.sessionLifecycle;

  if (group === 'session') {
    return (
      <Fragment>
        <Section title="生命周期" storageKey="lifecycle" defaultOpen>
          <ReadOnlyRow
            label="空闲多久后休眠"
            value={lifecycle ? duration(lifecycle.activeWindowMs) : '—'}
          />
          <ReadOnlyRow
            label="休眠多久后关闭"
            value={lifecycle ? duration(lifecycle.closeAfterMs) : '—'}
          />
          <ReadOnlyRow
            label="待处理请求超时"
            value={defaults ? duration(defaults.permissionTimeoutMs, '不超时') : '—'}
          />
          <ReadOnlyRow
            label="历史会话保留时间"
            value={lifecycle ? days(lifecycle.historyRetentionDays) : '—'}
          />
        </Section>
        <Section title="会话续接上下文" storageKey="continuation-context" defaultOpen={false}>
          <p className="text-[10px] leading-snug text-deck-muted/70">
            会话续接使用已有会话记录，这里没有需要单独填写的设置。
          </p>
        </Section>
        <Section title="间歇总结" storageKey="summary" defaultOpen={false}>
          <ReadOnlyChoice
            label="总结模型"
            value={placeholder(defaults?.summaryModel, '跟随默认设置')}
          />
          <ReadOnlyRow
            label="思考档位"
            value={thinking(defaults?.summaryThinking)}
          />
          <ReadOnlyRow
            label="总结超时"
            value={defaults ? duration(defaults.summaryTimeoutMs, '不超时') : '—'}
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
            连接由应用自动完成，没有需要填写的端口。
          </p>
        </Section>
        <Section title="外部工具" storageKey="external" defaultOpen={false}>
          <ReadOnlyChoice
            label="Claude Code 程序位置"
            value={executable(defaults?.claudeCliPath)}
          />
          <ReadOnlyChoice
            label="Codex CLI 程序位置"
            value={executable(defaults?.codexCliPath)}
          />
          <ReadOnlyChoice
            label="Grok Build 程序位置"
            value={executable(defaults?.grokCliPath)}
          />
        </Section>
        <Section title="实验功能" storageKey="experimental" defaultOpen={false}>
          <ReadOnlyChoice
            label="Claude Code 沙盒（系统隔离）"
            value={sandbox('claude', defaults?.claudeCodeSandbox)}
          />
          <ReadOnlyChoice
            label="Codex CLI 沙盒（系统隔离）"
            value={sandbox('codex', defaults?.codexSandbox)}
          />
          <ReadOnlyChoice
            label="Grok Build 沙盒（请求档位）"
            value={sandbox('grok', defaults?.grokSandbox)}
          />
        </Section>
      </Fragment>
    );
  }

  return (
    <Section title="Agent Deck MCP" storageKey="agent-deck-mcp" defaultOpen={false}>
      <ReadOnlyToggle
        label="允许会话使用协作功能"
        value={defaults?.enableAgentDeckMcp}
      />
      <ReadOnlyToggle
        label="允许 Codex CLI 和 Grok Build 连接"
        value={defaults?.mcpHttpEnabled}
      />
    </Section>
  );
}
