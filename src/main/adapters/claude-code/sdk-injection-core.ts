export interface ClaudeLocalPlugin {
  type: 'local';
  path: string;
}

export interface ClaudePluginSelectionOptions {
  includeAgents: boolean;
  includeSkills: boolean;
  installMirror(options: {
    includeAgents: boolean;
    includeSkills: boolean;
  }): string | null;
  selectedPluginDir?: string;
}

const APPEND_HEADER =
  '\n\n--- Agent Deck 应用约定（随应用打包，独立于 user/project/local CLAUDE.md）---\n\n';

/** Select bundled and native plugins without discovering settings or filesystem paths. */
export function selectClaudeSessionPlugins(
  options: ClaudePluginSelectionOptions,
): ClaudeLocalPlugin[] {
  const plugins: ClaudeLocalPlugin[] = [];
  if (options.includeSkills || options.includeAgents) {
    const mirrorPath = options.installMirror({
      includeSkills: options.includeSkills,
      includeAgents: options.includeAgents,
    });
    if (mirrorPath) plugins.push({ type: 'local', path: mirrorPath });
  }
  if (
    options.selectedPluginDir &&
    !plugins.some((plugin) => plugin.path === options.selectedPluginDir)
  ) {
    plugins.push({ type: 'local', path: options.selectedPluginDir });
  }
  return plugins;
}

/** Format the already-substituted application convention for SDK prompt append. */
export function formatClaudeSystemPromptAppend(substituted: string): string {
  return substituted ? `${APPEND_HEADER}${substituted}` : '';
}
