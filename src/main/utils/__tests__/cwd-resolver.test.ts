/**
 * cwd-resolver.ts 单测（REVIEW_37 P3-C Step 4.1 收口）。
 *
 * 4 个边界 case 守门 trim 后非空才用 caller cwd 的核心语义；任何回退到「opts.cwd ||
 * process.cwd()」宽松版（漏 trim 检查）的改动会被 whitespace case fail。
 */
import { describe, expect, it } from 'vitest';
import { resolveSpawnCwd } from '../cwd-resolver';

describe('resolveSpawnCwd', () => {
  it('returns process.cwd() when cwd is undefined', () => {
    expect(resolveSpawnCwd({})).toBe(process.cwd());
    expect(resolveSpawnCwd({ cwd: undefined })).toBe(process.cwd());
  });

  it('returns process.cwd() when cwd is null', () => {
    expect(resolveSpawnCwd({ cwd: null })).toBe(process.cwd());
  });

  it('returns process.cwd() when cwd is empty string', () => {
    expect(resolveSpawnCwd({ cwd: '' })).toBe(process.cwd());
  });

  // 关键 regression case：旧版 claude-runner / codex-runner 用 `opts.cwd || process.cwd()`，
  // `'   '` truthy 直接传 SDK 让 cli.js 撞 ENOENT。新版必须降级到 process.cwd()。
  it('returns process.cwd() when cwd is whitespace-only (trim non-empty check)', () => {
    expect(resolveSpawnCwd({ cwd: '   ' })).toBe(process.cwd());
    expect(resolveSpawnCwd({ cwd: '\t\n  ' })).toBe(process.cwd());
  });

  it('returns caller cwd verbatim when trim non-empty', () => {
    expect(resolveSpawnCwd({ cwd: '/Users/foo' })).toBe('/Users/foo');
  });

  // 边界：caller 输入含两端空白但 trim 非空 → 保留原值不 trim（下游 SDK 自己 normalize）。
  // 不 trim 是为了不擅自改 caller 输入，避免「helper 静默改字符串导致 caller 测断言意外」。
  it('preserves leading/trailing whitespace when trim non-empty (does not trim)', () => {
    expect(resolveSpawnCwd({ cwd: '  /Users/foo  ' })).toBe('  /Users/foo  ');
  });
});
