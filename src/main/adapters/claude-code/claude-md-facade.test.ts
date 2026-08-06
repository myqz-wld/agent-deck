import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ enabled: true, resourcesRoot: '', userDataPath: '' }));

vi.mock('@main/runtime-host/application-resources', () => ({
  getApplicationResourcesRoot: () => fixture.resourcesRoot,
}));
vi.mock('@main/runtime-host/application-paths', () => ({
  getApplicationHostPaths: () => ({ userDataPath: fixture.userDataPath }),
}));
vi.mock('@main/store/settings-store', () => ({
  settingsStore: {
    get: (key: string) => (key === 'injectAgentDeckClaudeMd' ? fixture.enabled : true),
  },
}));
vi.mock('@main/utils/resources-placeholder', () => ({
  substituteResourcesPlaceholder: (content: string) =>
    content.replace('{{AGENT_DECK_RESOURCES}}', fixture.resourcesRoot),
}));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ warn: vi.fn() }) },
}));

import {
  getActiveAgentDeckClaudeMd,
  getAgentDeckSystemPromptAppend,
  invalidateAgentDeckSystemPromptAppend,
  resetUserAgentDeckClaudeMd,
  saveUserAgentDeckClaudeMd,
} from './sdk-injection';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-deck-claude-md-facade-'));
  fixture.enabled = true;
  fixture.resourcesRoot = join(root, 'resources');
  fixture.userDataPath = join(root, 'user-data');
  const configRoot = join(fixture.resourcesRoot, 'claude-config');
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(
    join(configRoot, 'CLAUDE.md'),
    'Use {{AGENT_DECK_RESOURCES}}.\n',
    'utf8',
  );
  invalidateAgentDeckSystemPromptAppend();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('Claude markdown desktop facade', () => {
  it('applies the session setting and resource substitution outside the store', () => {
    expect(getAgentDeckSystemPromptAppend()).toContain(`Use ${fixture.resourcesRoot}.`);

    fixture.enabled = false;
    expect(getAgentDeckSystemPromptAppend()).toBe('');
  });

  it('preserves the settings editor save and reset contract', () => {
    expect(saveUserAgentDeckClaudeMd('# custom\n')).toEqual({
      content: '# custom\n',
      isCustom: true,
    });
    expect(getActiveAgentDeckClaudeMd()).toEqual({
      content: '# custom\n',
      isCustom: true,
    });

    resetUserAgentDeckClaudeMd();
    expect(getActiveAgentDeckClaudeMd()).toEqual({
      content: 'Use {{AGENT_DECK_RESOURCES}}.\n',
      isCustom: false,
    });
  });
});
