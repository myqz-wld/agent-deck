import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  initializeBuiltInClaudeGatewayProfiles,
  listClaudeGatewayProfiles,
  resolveClaudeGatewayProfile,
  type ClaudeGatewayPaths,
} from '../gateway-profiles';

function fixturePaths(): ClaudeGatewayPaths {
  const root = mkdtempSync(join(tmpdir(), 'agent-deck-gateway-'));
  return {
    gatewaysDir: join(root, '.claude', 'gateways'),
    legacyDeepseekSettingsPath: join(
      root,
      '.agent-deck',
      '.deepseek',
      'settings.json',
    ),
  };
}

describe('Claude Gateway profiles', () => {
  it('migrates the legacy Deepseek settings into the Claude Gateway directory', () => {
    const paths = fixturePaths();
    mkdirSync(join(paths.legacyDeepseekSettingsPath, '..'), { recursive: true });
    writeFileSync(
      paths.legacyDeepseekSettingsPath,
      JSON.stringify({
        token: 'secret-test-token',
        model: 'deepseek-v4-pro[1m]',
        haikuModel: 'deepseek-v4-flash',
      }),
    );

    const settingsPath = initializeBuiltInClaudeGatewayProfiles(paths);
    const migrated = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      env: Record<string, string>;
    };
    expect(migrated.env.ANTHROPIC_AUTH_TOKEN).toBe('secret-test-token');
    expect(migrated.env.ANTHROPIC_MODEL).toBe('deepseek-v4-pro[1m]');
    expect(migrated.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(
      'deepseek-v4-flash',
    );
  });

  it('discovers JSON profiles and resolves only model metadata plus settings path', () => {
    const paths = fixturePaths();
    initializeBuiltInClaudeGatewayProfiles(paths);
    mkdirSync(paths.gatewaysDir, { recursive: true });
    writeFileSync(
      join(paths.gatewaysDir, 'openrouter.json'),
      JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: 'must-not-leak',
          ANTHROPIC_MODEL: 'openrouter/model',
        },
      }),
    );
    writeFileSync(join(paths.gatewaysDir, 'ignored.txt'), '{}');

    expect(listClaudeGatewayProfiles(paths).map((profile) => profile.id)).toEqual([
      'deepseek',
      'openrouter',
    ]);
    const resolved = resolveClaudeGatewayProfile('openrouter', paths);
    expect(resolved).toMatchObject({
      id: 'openrouter',
      settingsPath: join(paths.gatewaysDir, 'openrouter.json'),
      defaultModel: 'openrouter/model',
    });
    expect(JSON.stringify(resolved)).not.toContain('must-not-leak');
  });

  it('rejects traversal and missing profile ids', () => {
    const paths = fixturePaths();
    expect(() => resolveClaudeGatewayProfile('../deepseek', paths)).toThrow(
      /Invalid Claude Gateway profile/,
    );
    expect(() => resolveClaudeGatewayProfile('openrouter', paths)).toThrow(
      /was not found/,
    );
  });
});
