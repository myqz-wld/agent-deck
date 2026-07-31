/**
 * frontmatter.ts round-trip 单测（CHANGELOG_57 R2·R2-F6 收口）。
 *
 * 重点 regression case 来自 R2·R2-F1（双方 reviewer 独立实测复现的 unquoteValue 顺序 bug）：
 * 字面 backslash + n 在旧版多次 `.replace()` 实现下被误解码为换行——本测试守门，未来任何
 * 「unquote 顺序回退到 sequential replace」改动会被这条 case fail。
 */
import { describe, expect, it } from 'vitest';
import { parseFrontmatter, stringifyFrontmatter } from '../frontmatter';

describe('frontmatter round-trip', () => {
  // 关键 regression case：R2·R2-F1 双方实测复现
  it('preserves literal backslash+n (Windows path / regex literal)', () => {
    const fm = { name: 'x', description: 'see C:\\new folder' };
    const written = stringifyFrontmatter(fm) + '\n\nbody.\n';
    expect(parseFrontmatter(written)).toEqual(fm);
  });

  it('preserves literal backslash+r', () => {
    const fm = { name: 'x', description: 'use \\r for CR' };
    const written = stringifyFrontmatter(fm) + '\n\nbody.\n';
    expect(parseFrontmatter(written)).toEqual(fm);
  });

  it('preserves literal backslash+t', () => {
    const fm = { name: 'x', description: 'tab \\t here' };
    const written = stringifyFrontmatter(fm) + '\n\nbody.\n';
    expect(parseFrontmatter(written)).toEqual(fm);
  });

  it('preserves embedded double quotes', () => {
    const fm = { name: 'x', description: 'say "hello"' };
    const written = stringifyFrontmatter(fm) + '\n\nbody.\n';
    expect(parseFrontmatter(written)).toEqual(fm);
  });

  it('preserves double backslash (Windows root)', () => {
    const fm = { name: 'x', description: 'C:\\\\Users' };
    const written = stringifyFrontmatter(fm) + '\n\nbody.\n';
    expect(parseFrontmatter(written)).toEqual(fm);
  });

  it('preserves trailing backslash (lonely \\)', () => {
    const fm = { name: 'x', description: 'end\\' };
    const written = stringifyFrontmatter(fm) + '\n\nbody.\n';
    expect(parseFrontmatter(written)).toEqual(fm);
  });

  it('preserves YAML-special chars (: # | > * & !)', () => {
    const fm = { name: 'x', description: 'do thing: param # ok | x > y * z & a !' };
    const written = stringifyFrontmatter(fm) + '\n\nbody.\n';
    expect(parseFrontmatter(written)).toEqual(fm);
  });

  it('preserves chinese + fullwidth colon', () => {
    const fm = { name: 'x', description: '中文描述：触发条件' };
    const written = stringifyFrontmatter(fm) + '\n\nbody.\n';
    expect(parseFrontmatter(written)).toEqual(fm);
  });

  it('preserves emoji + unicode', () => {
    const fm = { name: 'x', description: '🚀 触发关键词 emoji 🎯' };
    const written = stringifyFrontmatter(fm) + '\n\nbody.\n';
    expect(parseFrontmatter(written)).toEqual(fm);
  });

  it('preserves empty value', () => {
    const fm = { name: 'x', description: '' };
    const written = stringifyFrontmatter(fm) + '\n\nbody.\n';
    expect(parseFrontmatter(written)).toEqual(fm);
  });

  it('preserves all 4 frontmatter fields together', () => {
    const fm = {
      name: 'reviewer-test',
      description: 'test agent for: edge cases # with quotes "..." and \\n literal',
      tools: 'Read, Grep, Glob',
      model: 'opus',
    };
    const written = stringifyFrontmatter(fm) + '\n\nbody.\n';
    expect(parseFrontmatter(written)).toEqual(fm);
  });

  it('parses unquoted scalar fields', () => {
    const unquoted = '---\nname: reviewer-claude\ndescription: 异构对抗 review\ntools: Read, Grep\n---\n\nbody.\n';
    expect(parseFrontmatter(unquoted)).toEqual({
      name: 'reviewer-claude',
      description: '异构对抗 review',
      tools: 'Read, Grep',
    });
  });

  it('keeps a hash inside an unquoted description', () => {
    const unquoted = '---\nname: x\ndescription: text with # hash\n---\n\nbody.\n';
    expect(parseFrontmatter(unquoted)).toEqual({
      name: 'x',
      description: 'text with # hash',
    });
  });

  it('returns empty object when no frontmatter block', () => {
    expect(parseFrontmatter('# pure markdown\nno frontmatter here')).toEqual({});
  });

  it('parses folded block scalar descriptions without exposing the marker', () => {
    const content = [
      '---',
      'name: folded',
      'description: >-',
      '  Use this skill for complex work',
      '  across multiple steps.',
      '',
      '  Keep the plan current.',
      '---',
      'Body',
      '',
    ].join('\n');

    expect(parseFrontmatter(content).description).toBe(
      'Use this skill for complex work across multiple steps.\nKeep the plan current.',
    );
  });

  it('parses literal block scalar descriptions with internal newlines', () => {
    const content = [
      '---',
      'name: literal',
      'description: |',
      '  First line',
      '  Second line',
      '---',
      'Body',
      '',
    ].join('\n');

    expect(parseFrontmatter(content).description).toBe('First line\nSecond line');
  });

  it('handles unknown escape sequence by preserving backslash', () => {
    // \\x 不是支持的 escape；当前实现保留 backslash 不消耗 next 字符。
    // round-trip：input "a\\xb" → quote 写成 "a\\\\xb"（escape backslash）→ unquote 走 \\\\ → \\
    // 最终回到 "a\\xb"。这条 case 保护「不识别的 escape 不静默吞」契约。
    const fm = { name: 'x', description: 'unknown \\x escape' };
    const written = stringifyFrontmatter(fm) + '\n\nbody.\n';
    expect(parseFrontmatter(written)).toEqual(fm);
  });
});
