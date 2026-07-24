import { type JSX, type ReactNode } from 'react';

interface AdapterHelpConfig {
  name: 'Claude Code' | 'Codex CLI' | 'Grok Build';
  configPaths: ReactNode;
  managedFeatures: string;
  terminalIntegration: ReactNode;
  inAppFeatures?: ReactNode;
}

function InlineCode({ children }: { children: ReactNode }): JSX.Element {
  return <code className="rounded bg-white/5 px-1">{children}</code>;
}

const CONFIGS: Record<'claude' | 'codex' | 'grok', AdapterHelpConfig> = {
  claude: {
    name: 'Claude Code',
    configPaths: (
      <>
        <InlineCode>~/.claude/settings.json</InlineCode> 和项目根目录的{' '}
        <InlineCode>.mcp.json</InlineCode>
      </>
    ),
    managedFeatures: '模型、权限、沙盒和 MCP',
    terminalIntegration: (
      <>
        安装上方 Hook 后，外部终端会话通过{' '}
        <InlineCode>~/.claude/settings.json</InlineCode> 上报到 Agent Deck。
      </>
    ),
  },
  codex: {
    name: 'Codex CLI',
    configPaths: <InlineCode>~/.codex/config.toml</InlineCode>,
    managedFeatures: '模型、权限、沙盒和 MCP',
    terminalIntegration: (
      <>
        安装上方 Hook 后，外部终端会话通过{' '}
        <InlineCode>~/.codex/hooks.json</InlineCode> 上报到 Agent Deck。
      </>
    ),
  },
  grok: {
    name: 'Grok Build',
    configPaths: <InlineCode>~/.grok/config.toml</InlineCode>,
    managedFeatures: '模型别名、推理参数、认证和 MCP',
    terminalIntegration: (
      <>
        安装上方 Hook 后，外部终端会话通过{' '}
        <InlineCode>~/.grok/hooks/agent-deck.json</InlineCode> 上报到 Agent Deck；应用内会话仍通过官方 ACP 连接。
      </>
    ),
    inAppFeatures: (
      <>
        应用内会话通过 ACP 注入 Agent Deck 应用约定、内置 skills / Agents 和按 adapter
        过滤的 MCP 工具；Grok 原生配置与登录状态仍由 Grok CLI 管理。
      </>
    ),
  },
};

/** Adapter settings pages share one layout while preserving provider-specific capabilities. */
export function AdapterConfigHelp({
  adapter,
}: {
  adapter: 'claude' | 'codex' | 'grok';
}): JSX.Element {
  const config = CONFIGS[adapter];
  return (
    <div className="flex flex-col gap-2 text-[10px] leading-snug text-deck-muted/70">
      <p>
        <strong className="text-deck-text/80">运行配置：</strong>
        {config.name} 的{config.managedFeatures}等在 {config.configPaths} 中管理。
      </p>
      <p>
        <strong className="text-deck-text/80">终端接入：</strong>
        {config.terminalIntegration}
      </p>
      <p>
        <strong className="text-deck-text/80">应用内功能：</strong>
        {config.inAppFeatures ?? (
          <>
            应用内会话会注入 Agent Deck 应用约定和内置 skills；间歇总结与会话续接上下文在「通用 →
            会话」设置，内置 MCP 在「通用 → 跨工具协作（MCP）」设置。
          </>
        )}
      </p>
    </div>
  );
}
