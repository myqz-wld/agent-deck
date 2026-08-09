import { join } from 'node:path';
import { settingsStore } from '@main/store/settings-store';
import { substituteResourcesPlaceholder } from '@main/utils/resources-placeholder';
import { getApplicationResourcesRoot } from '@main/runtime-host/application-resources';
import { getApplicationHostPaths } from '@main/runtime-host/application-paths';

const USER_CLAUDE_MD_FILENAME = 'agent-deck-claude.md';

export const desktopClaudeSdkInjectionHost = {
  builtinClaudeMdPath: () =>
    join(getApplicationResourcesRoot(), 'claude-config', 'CLAUDE.md'),
  pluginMirrorDir: () =>
    join(getApplicationHostPaths().userDataPath, 'agent-deck-plugin'),
  pluginSourceDir: () =>
    join(
      getApplicationResourcesRoot(),
      'claude-config',
      'agent-deck-plugin',
    ),
  readInjectAgents: () =>
    settingsStore.get('injectAgentDeckClaudeAgents') !== false,
  readInjectClaudeMd: () => settingsStore.get('injectAgentDeckClaudeMd') === true,
  readInjectSkills: () =>
    settingsStore.get('injectAgentDeckClaudeSkills') !== false,
  substituteMarkdown: (content: string) => substituteResourcesPlaceholder(content),
  userClaudeMdPath: () =>
    join(
      getApplicationHostPaths().userDataPath,
      USER_CLAUDE_MD_FILENAME,
    ),
};
