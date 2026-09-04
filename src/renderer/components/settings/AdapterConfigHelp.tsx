import { type JSX, type ReactNode } from 'react';

interface AdapterHelpConfig {
  name: 'Claude Code' | 'Codex CLI' | 'Grok Build';
  configPaths: ReactNode;
  managedFeatures: string;
  hookPath: string;
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
    hookPath: '~/.claude/settings.json',
  },
  codex: {
    name: 'Codex CLI',
    configPaths: <InlineCode>~/.codex/config.toml</InlineCode>,
    managedFeatures: '模型、权限、沙盒和 MCP',
    hookPath: '~/.codex/hooks.json',
  },
  grok: {
    name: 'Grok Build',
    configPaths: <InlineCode>~/.grok/config.toml</InlineCode>,
    managedFeatures: '模型别名、推理参数、认证和 MCP',
    hookPath: '~/.grok/hooks/agent-deck.json',
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
        安装上方 Hook 后，外部终端中的 {config.name} 会话会通过{' '}
        <InlineCode>{config.hookPath}</InlineCode> 上报到 Agent Deck。
      </p>
      <p>
        <strong className="text-deck-text/80">应用内功能：</strong>
        Agent Deck 内的 {config.name} 会话会加载应用约定、内置 Skills、Agents 和 MCP
        工具；间歇总结与会话续接上下文在「通用 → 会话」中设置，MCP 在「通用 →
        跨工具协作（MCP）」中设置。
      </p>
    </div>
  );
}
