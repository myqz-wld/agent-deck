/**
 * generic-pty.ts schema + preset 单测（R4·F1）。
 *
 * 守门点：
 * - 全字段 parse：valid 路径
 * - partial 输入 → defaults 填充：UI 表单仅 require command 时下游能拿到完整 config
 * - command 空：先把 trim/null 的脏入侵挡在 schema 层，避免 PTY spawn 拿到 ''
 * - idleQuietMs 负数 / 非整数：避免 setTimeout(NaN) / setTimeout(-1) 退化
 * - env 非 string-string：防 IPC bypass 灌入 number / undefined
 * - 内置 preset 自身合法：每条 preset.config 必须能过 schema parse（防 preset 修订时打入非法默认）
 */

import { describe, expect, it } from 'vitest';
import {
  GENERIC_PTY_PRESETS,
  genericPtyConfigSchema,
  getGenericPtyPreset,
  parseGenericPtyConfig,
} from '../generic-pty';

describe('genericPtyConfigSchema', () => {
  it('parses fully populated config', () => {
    const config = {
      command: '/usr/local/bin/aider',
      args: ['--no-stream', '--no-pretty'],
      env: { OPENAI_API_KEY: 'sk-xxx' },
      cwd: '/repo',
      idleQuietMs: 1500,
      promptSuffixRegex: '\\>\\s*$',
    };
    expect(parseGenericPtyConfig(config)).toEqual(config);
  });

  it('fills defaults when only command provided', () => {
    const result = parseGenericPtyConfig({ command: 'aider' });
    expect(result).toEqual({
      command: 'aider',
      args: [],
      env: {},
      cwd: '',
      idleQuietMs: 3000,
      promptSuffixRegex: '',
    });
  });

  it('rejects empty command (PTY spawn cannot take blank executable)', () => {
    expect(() => parseGenericPtyConfig({ command: '' })).toThrow();
  });

  it('rejects missing command (required field)', () => {
    expect(() => parseGenericPtyConfig({})).toThrow();
  });

  it('rejects negative idleQuietMs', () => {
    expect(() =>
      parseGenericPtyConfig({ command: 'aider', idleQuietMs: -1 }),
    ).toThrow();
  });

  it('rejects non-integer idleQuietMs (would degrade setTimeout)', () => {
    expect(() =>
      parseGenericPtyConfig({ command: 'aider', idleQuietMs: 1500.5 }),
    ).toThrow();
  });

  it('rejects non-string-keyed env entries', () => {
    expect(() =>
      parseGenericPtyConfig({
        command: 'aider',
        env: { OPENAI_API_KEY: 42 },
      }),
    ).toThrow();
  });

  it('rejects non-array args', () => {
    expect(() =>
      parseGenericPtyConfig({ command: 'aider', args: '--no-stream' }),
    ).toThrow();
  });

  it('throws zod error (caller can introspect issues)', () => {
    try {
      genericPtyConfigSchema.parse({ command: '' });
      expect.fail('expected schema parse to throw');
    } catch (err) {
      // zod 4: ZodError 实例带 issues 数组
      expect(err).toBeInstanceOf(Error);
      const issues = (err as { issues?: unknown[] }).issues;
      expect(Array.isArray(issues)).toBe(true);
      expect(issues!.length).toBeGreaterThan(0);
    }
  });
});

describe('GENERIC_PTY_PRESETS', () => {
  it('exports a non-empty preset list', () => {
    expect(GENERIC_PTY_PRESETS.length).toBeGreaterThan(0);
  });

  it('includes the aider preset (UI default for "Aider" adapter)', () => {
    const aider = getGenericPtyPreset('aider');
    expect(aider).toBeDefined();
    expect(aider?.config.command).toBe('aider');
    // aider 实测：默认 --no-stream + --no-pretty 让 stdout 一段一段来，对 ANSI strip + idle 友好
    expect(aider?.config.args).toEqual(['--no-stream', '--no-pretty']);
  });

  it('every preset.config is itself a valid GenericPtyConfig', () => {
    // 防 preset 修订时打入非法默认 → 守门
    for (const preset of GENERIC_PTY_PRESETS) {
      expect(() => parseGenericPtyConfig(preset.config)).not.toThrow();
    }
  });

  it('preset ids are unique', () => {
    const ids = GENERIC_PTY_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns undefined for unknown preset id', () => {
    expect(getGenericPtyPreset('does-not-exist')).toBeUndefined();
  });
});
