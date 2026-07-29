import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingsLayer, SettingsSource } from '@shared/types';
import {
  MAX_MERGED_PERMISSION_ENTRIES,
  MAX_PERMISSION_CWD_BYTES,
  MAX_PERMISSION_JSON_DEPTH,
  MAX_PERMISSION_JSON_NODES,
  MAX_PERMISSION_RULE_LENGTH,
  MAX_PERMISSION_RULES_PER_FIELD,
  MAX_PERMISSION_SETTINGS_BYTES,
  getCandidatePaths,
  mergePermissions,
  scanCwdSettings,
} from '../scanner';

const roots: string[] = [];

function layout(): { root: string; homeDir: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), 'permission-scanner-'));
  roots.push(root);
  const homeDir = join(root, 'home');
  const cwd = join(root, 'project');
  mkdirSync(join(homeDir, '.claude'), { recursive: true });
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  return { root, homeDir, cwd };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Claude Code permission settings scanner bounds', () => {
  it('reads each canonical file once and preserves source-specific display paths', async () => {
    const { homeDir, cwd } = layout();
    const readFile = vi.fn(async (path: string) => JSON.stringify({
      permissions: {
        allow: [path.endsWith('local') ? 'Read(*)' : 'Bash(*)'],
      },
    }));
    const canonicalize = vi.fn(async (path: string) => (
      path.endsWith('settings.local.json') ? 'canonical-local' : 'canonical-settings'
    ));

    const result = await scanCwdSettings(cwd, {
      homeDir,
      canonicalize,
      readFile,
    });

    expect(canonicalize).toHaveBeenCalledTimes(4);
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(result.user.path).toBe(join(homeDir, '.claude', 'settings.json'));
    expect(result.project.path).toBe(join(cwd, '.claude', 'settings.json'));
    expect(result.user.source).toBe('user');
    expect(result.project.source).toBe('project');
    expect(result.merged.allow).toEqual([
      { rule: 'Bash(*)', sources: ['user', 'project'] },
      { rule: 'Read(*)', sources: ['user-local', 'local'] },
    ]);
    expect('parsed' in result.user).toBe(false);
  });

  it('preserves bounded original JSON and merges valid rules', async () => {
    const { homeDir, cwd } = layout();
    const paths = getCandidatePaths(cwd, homeDir);
    const raw = JSON.stringify({
      permissions: {
        allow: ['Bash(git:*)'],
        deny: ['Read(.env)'],
        ask: ['WebFetch(*)'],
        additionalDirectories: ['/tmp/review-cache'],
        defaultMode: 'default',
      },
    });
    writeFileSync(paths.user, raw, 'utf8');

    const result = await scanCwdSettings(cwd, { homeDir });

    expect(result.user.raw).toBe(raw);
    expect(result.user.parseError).toBeNull();
    expect(result.user.permissions?.allow).toEqual(['Bash(git:*)']);
    expect(result.merged.defaultMode).toEqual({ value: 'default', source: 'user' });
  });

  it('rejects a file above the byte limit without returning its content', async () => {
    const { homeDir, cwd } = layout();
    const paths = getCandidatePaths(cwd, homeDir);
    writeFileSync(paths.user, 'x'.repeat(MAX_PERMISSION_SETTINGS_BYTES + 1), 'utf8');

    const result = await scanCwdSettings(cwd, { homeDir });

    expect(result.user).toMatchObject({
      exists: true,
      raw: null,
      parseError: '设置文件超过安全扫描上限',
      permissions: null,
    });
    expect(JSON.stringify(result)).not.toContain('xxxxxxxxxxxxxxxx');
  });

  it('accepts exact byte, rule-count, and rule-length boundaries', async () => {
    const { homeDir, cwd } = layout();
    const paths = getCandidatePaths(cwd, homeDir);
    const boundaryRules = Array.from(
      { length: MAX_PERMISSION_RULES_PER_FIELD },
      (_, index) => `Rule-${index}`,
    );
    boundaryRules[0] = 'x'.repeat(MAX_PERMISSION_RULE_LENGTH);
    writeFileSync(paths.user, JSON.stringify({
      permissions: { allow: boundaryRules },
    }), 'utf8');

    let result = await scanCwdSettings(cwd, { homeDir });
    expect(result.user.parseError).toBeNull();
    expect(result.user.permissions?.allow).toHaveLength(MAX_PERMISSION_RULES_PER_FIELD);

    const exactFile = '{}'.padEnd(MAX_PERMISSION_SETTINGS_BYTES, ' ');
    writeFileSync(paths.user, exactFile, 'utf8');
    result = await scanCwdSettings(cwd, { homeDir });
    expect(result.user.parseError).toBeNull();
    expect(result.user.raw).toHaveLength(MAX_PERMISSION_SETTINGS_BYTES);
  });

  it('rejects excessive JSON depth and node count before returning parsed output', async () => {
    const { homeDir, cwd } = layout();
    const paths = getCandidatePaths(cwd, homeDir);
    const tooDeep = '['.repeat(MAX_PERMISSION_JSON_DEPTH + 1)
      + '0'
      + ']'.repeat(MAX_PERMISSION_JSON_DEPTH + 1);
    writeFileSync(paths.user, tooDeep, 'utf8');

    let result = await scanCwdSettings(cwd, { homeDir });
    expect(result.user.parseError).toBe('JSON 结构超过安全扫描上限');
    expect(result.user.permissions).toBeNull();

    const tooManyNodes = JSON.stringify({
      values: Array.from({ length: MAX_PERMISSION_JSON_NODES + 1 }, () => 0),
    });
    writeFileSync(paths.user, tooManyNodes, 'utf8');
    result = await scanCwdSettings(cwd, { homeDir });
    expect(result.user.parseError).toBe('JSON 结构超过安全扫描上限');
    expect(result.user.permissions).toBeNull();
  });

  it('rejects excessive permission counts and value lengths without partial merge', async () => {
    const { homeDir, cwd } = layout();
    const paths = getCandidatePaths(cwd, homeDir);
    writeFileSync(paths.user, JSON.stringify({
      permissions: {
        allow: Array.from(
          { length: MAX_PERMISSION_RULES_PER_FIELD + 1 },
          (_, index) => `Bash(tool-${index}:*)`,
        ),
      },
    }), 'utf8');

    let result = await scanCwdSettings(cwd, { homeDir });
    expect(result.user.parseError).toBe('权限规则超过安全扫描上限');
    expect(result.merged.allow).toEqual([]);

    writeFileSync(paths.user, JSON.stringify({
      permissions: { allow: ['x'.repeat(MAX_PERMISSION_RULE_LENGTH + 1)] },
    }), 'utf8');
    result = await scanCwdSettings(cwd, { homeDir });
    expect(result.user.parseError).toBe('权限规则超过安全扫描上限');
    expect(result.merged.allow).toEqual([]);
  });

  it('returns a fixed read failure without leaking paths or raw errors', async () => {
    const { homeDir, cwd } = layout();
    const marker = 'RAW_PERMISSION_SECRET token=private /Users/private/repo';
    const result = await scanCwdSettings(cwd, {
      homeDir,
      canonicalize: async (path) => path,
      readFile: async () => {
        throw new Error(marker);
      },
    });

    expect(result.user).toMatchObject({
      exists: true,
      raw: null,
      parseError: '设置文件读取失败',
      permissions: null,
    });
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it('rejects an oversized cwd before constructing or reading candidate paths', async () => {
    const readFile = vi.fn(async () => '{}');
    await expect(scanCwdSettings('x'.repeat(MAX_PERMISSION_CWD_BYTES + 1), {
      readFile,
    })).rejects.toThrow('权限扫描目录超过长度上限');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('caps merged output and reports truncation', () => {
    const sources: SettingsSource[] = ['user', 'user-local', 'project', 'local'];
    const layers: SettingsLayer[] = sources.map((source, sourceIndex) => ({
      source,
      path: `/settings/${source}`,
      exists: true,
      raw: '{}',
      parseError: null,
      permissions: {
        allow: Array.from(
          { length: 200 },
          (_, index) => `Rule-${sourceIndex}-${index}`,
        ),
        deny: [],
        ask: [],
        additionalDirectories: [],
        defaultMode: null,
      },
    }));

    const merged = mergePermissions(layers);
    expect(merged.allow).toHaveLength(MAX_MERGED_PERMISSION_ENTRIES);
    expect(merged.truncated).toBe(true);
  });

  it('normalizes invalid bounds and filters non-string permission values', async () => {
    const { homeDir, cwd } = layout();
    const result = await scanCwdSettings(cwd, {
      homeDir,
      canonicalize: async (path) => path,
      readFile: async () => JSON.stringify({
        permissions: {
          allow: ['Bash(*)', null, 4],
          deny: [],
          ask: [],
          additionalDirectories: ['/tmp/cache', false],
          defaultMode: 4,
        },
      }),
    });

    expect(result.user.permissions).toEqual({
      allow: ['Bash(*)'],
      deny: [],
      ask: [],
      additionalDirectories: ['/tmp/cache'],
      defaultMode: null,
    });
  });
});
