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
  settingsStore: { get: () => fixture.enabled },
}));
vi.mock('@main/utils/resources-placeholder', () => ({
  substituteResourcesPlaceholder: (content: string) =>
    content.replace('{{AGENT_DECK_RESOURCES}}', fixture.resourcesRoot),
}));
vi.mock('@main/utils/logger', () => ({
  default: { scope: () => ({ warn: vi.fn() }) },
}));

import {
  getActiveCodexAgentsMd,
  getAgentDeckCodexDeveloperInstructions,
  resetUserCodexAgentsMd,
  saveUserCodexAgentsMd,
} from './agents-md-installer';

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-deck-codex-agents-facade-'));
  fixture.enabled = true;
  fixture.resourcesRoot = join(root, 'resources');
  fixture.userDataPath = join(root, 'user-data');
  const configRoot = join(fixture.resourcesRoot, 'codex-config');
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(
    join(configRoot, 'CODEX_AGENTS.md'),
    'Use {{AGENT_DECK_RESOURCES}}.\n',
    'utf8',
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('Codex agents markdown desktop facade', () => {
  it('applies the session setting and resource substitution outside the store', () => {
    expect(getAgentDeckCodexDeveloperInstructions()).toBe(
      `--- Agent Deck application conventions ---\n\nUse ${fixture.resourcesRoot}.`,
    );

    fixture.enabled = false;
    expect(getAgentDeckCodexDeveloperInstructions()).toBeUndefined();
  });

  it('preserves the settings editor save and reset contract', () => {
    expect(saveUserCodexAgentsMd('# custom\n')).toEqual({
      content: '# custom\n',
      isCustom: true,
    });
    expect(getActiveCodexAgentsMd()).toEqual({
      content: '# custom\n',
      isCustom: true,
    });

    resetUserCodexAgentsMd();
    expect(getActiveCodexAgentsMd()).toEqual({
      content: 'Use {{AGENT_DECK_RESOURCES}}.\n',
      isCustom: false,
    });
  });
});
