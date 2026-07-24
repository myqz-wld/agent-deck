import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  listClaudeGatewayProfiles,
  resolveClaudeGatewayProfile,
  type ClaudeGatewayPaths,
} from '../gateway-profiles';

function fixturePaths(): ClaudeGatewayPaths {
  const root = mkdtempSync(join(tmpdir(), 'agent-deck-gateway-'));
  return {
    gatewaysDir: join(root, '.claude', 'gateways'),
  };
}

describe('Claude Gateway profiles', () => {
  it('does not create a built-in profile when the Gateway directory is missing', () => {
    const paths = fixturePaths();
    expect(listClaudeGatewayProfiles(paths)).toEqual([]);
  });

  it('discovers JSON profiles and resolves only model metadata plus settings path', () => {
    const paths = fixturePaths();
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

  it('sorts discovered profiles without a provider-specific priority', () => {
    const paths = fixturePaths();
    mkdirSync(paths.gatewaysDir, { recursive: true });
    for (const id of ['openrouter', 'deepseek', 'anthropic']) {
      writeFileSync(join(paths.gatewaysDir, `${id}.json`), '{}');
    }

    expect(listClaudeGatewayProfiles(paths).map((profile) => profile.id)).toEqual([
      'anthropic',
      'deepseek',
      'openrouter',
    ]);
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
