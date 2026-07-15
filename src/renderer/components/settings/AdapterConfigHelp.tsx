import { type JSX, type ReactNode } from 'react';

interface AdapterHelpConfig {
  name: 'Claude Code' | 'Codex CLI';
  configPaths: ReactNode;
  hookPath: string;
}

function InlineCode({ children }: { children: ReactNode }): JSX.Element {
  return <code className="rounded bg-white/5 px-1">{children}</code>;
}

const CONFIGS: Record<'claude' | 'codex', AdapterHelpConfig> = {
  claude: {
    name: 'Claude Code',
    configPaths: (
      <>
        <InlineCode>~/.claude/settings.json</InlineCode> 和项目根目录的{' '}
        <InlineCode>.mcp.json</InlineCode>
      </>
    ),
    hookPath: '~/.claude/settings.json',
  },
  codex: {
    name: 'Codex CLI',
    configPaths: <InlineCode>~/.codex/config.toml</InlineCode>,
    hookPath: '~/.codex/hooks.json',
  },
};

/** Claude Code / Codex CLI 设置页共用的说明模板。 */
export function AdapterConfigHelp({ adapter }: { adapter: 'claude' | 'codex' }): JSX.Element {
  const config = CONFIGS[adapter];
  return (
    <div className="flex flex-col gap-2 text-[10px] leading-snug text-deck-muted/70">
      <p>
        <strong className="text-deck-text/80">运行配置：</strong>
        {config.name} 的模型、权限、沙盒和 MCP 等在 {config.configPaths} 中管理。
      </p>
      <p>
        <strong className="text-deck-text/80">终端接入：</strong>
        安装上方 Hook 后，外部终端会话通过 <InlineCode>{config.hookPath}</InlineCode> 上报到
        Agent Deck。
      </p>
      <p>
        <strong className="text-deck-text/80">应用内功能：</strong>
        应用内会话会注入 Agent Deck 应用约定和内置 skills；间歇总结与会话续接上下文在「通用 →
        会话」设置，内置 MCP 在「通用 → 跨工具协作（MCP）」设置。
      </p>
    </div>
  );
}
