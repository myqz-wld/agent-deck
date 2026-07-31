import { describe, expect, it } from 'vitest';
import { parseWirePrefix, sanitizeWireFieldName } from '../wire-prefix';

describe('parseWirePrefix', () => {
  it('parses the current prefix with msgId + senderSessionId', () => {
    const text =
      '[from Lead @ claude-code][msg msg-abc-123][sid sender-sid-456]\nReply chain message body';
    const parsed = parseWirePrefix(text);
    expect(parsed).toEqual({
      from: 'Lead',
      adapter: 'claude-code',
      msgId: 'msg-abc-123',
      senderSessionId: 'sender-sid-456',
      body: 'Reply chain message body',
    });
  });

  it('returns null for plain user input (no wire prefix)', () => {
    expect(parseWirePrefix('Just a regular user message')).toBeNull();
    expect(parseWirePrefix('hello world')).toBeNull();
  });

  it('returns null for empty / non-string input', () => {
    expect(parseWirePrefix('')).toBeNull();
    expect(parseWirePrefix(null as unknown as string)).toBeNull();
    expect(parseWirePrefix(undefined as unknown as string)).toBeNull();
  });

  it('returns null for prefix-like text without trailing newline', () => {
    expect(parseWirePrefix('[from X @ y][msg z]no newline')).toBeNull();
    expect(parseWirePrefix('[from X @ y]')).toBeNull();
    expect(parseWirePrefix('[from X @ y][msg z][sid s]no newline')).toBeNull();
  });

  it('preserves multi-line body intact (with sid)', () => {
    const text = '[from R @ claude-code][msg m1][sid s1]\nLine 1\nLine 2\n\nLine 4 (after blank)';
    const parsed = parseWirePrefix(text);
    expect(parsed?.body).toBe('Line 1\nLine 2\n\nLine 4 (after blank)');
    expect(parsed?.senderSessionId).toBe('s1');
  });

  it('handles displayName with spaces and special chars (no `]`)', () => {
    const text = '[from Claude Code · 副 reviewer @ claude-code][msg m1][sid s1]\nBody';
    const parsed = parseWirePrefix(text);
    expect(parsed?.from).toBe('Claude Code · 副 reviewer');
    expect(parsed?.adapter).toBe('claude-code');
    expect(parsed?.senderSessionId).toBe('s1');
  });

  it('returns null when text does not start with `[from `', () => {
    // 防御：startsWith fast-path 已挡，但 regex 也应自然不匹配
    expect(parseWirePrefix('xx[from Y @ z][msg m][sid s]\nbody')).toBeNull();
    expect(parseWirePrefix(' [from Y @ z][msg m][sid s]\nbody')).toBeNull(); // 前导空格不允许
  });

  it('handles fallback displayName format (`<adapterId>:<sid 前 8>`) with sid', () => {
    // 当 team_member.display_name 缺失时，buildWireBody 用 `${adapterId}:${sid.slice(0,8)}`
    const text =
      '[from claude-code:abc12345 @ claude-code][msg m1][sid abc1234567890ef]\nFallback display';
    const parsed = parseWirePrefix(text);
    expect(parsed?.from).toBe('claude-code:abc12345');
    expect(parsed?.senderSessionId).toBe('abc1234567890ef');
  });

  it('rejects prefixes missing either reply-chain anchor', () => {
    expect(parseWirePrefix('[from X @ y][msg m]\nbody')).toBeNull();
    expect(parseWirePrefix('[from X @ y][sid s]\nbody')).toBeNull();
    expect(parseWirePrefix('[from X @ y]\nbody')).toBeNull();
  });
});

// CHANGELOG_100 R2 fix (codex MED-1): sanitizeWireFieldName 防 `]` / `\n` / `[` 破坏 wire prefix
describe('sanitizeWireFieldName', () => {
  it('replaces `]` / `[` / `\\n` / `\\r` with single space', () => {
    expect(sanitizeWireFieldName('foo]bar')).toBe('foo bar');
    expect(sanitizeWireFieldName('foo[bar')).toBe('foo bar');
    expect(sanitizeWireFieldName('foo\nbar')).toBe('foo bar');
    expect(sanitizeWireFieldName('foo\rbar')).toBe('foo bar');
    expect(sanitizeWireFieldName('a]b[c\nd')).toBe('a b c d');
  });

  it('collapses consecutive bad chars to single space', () => {
    expect(sanitizeWireFieldName('foo]]]bar')).toBe('foo bar');
    expect(sanitizeWireFieldName('foo\n\r\nbar')).toBe('foo bar');
  });

  it('trims leading/trailing whitespace', () => {
    expect(sanitizeWireFieldName('  foo  ')).toBe('foo');
    expect(sanitizeWireFieldName(']foo]')).toBe('foo');
  });

  it('returns single-space fallback when result becomes empty', () => {
    expect(sanitizeWireFieldName('')).toBe(' ');
    expect(sanitizeWireFieldName(']]]')).toBe(' ');
    expect(sanitizeWireFieldName('\n\r')).toBe(' ');
    expect(sanitizeWireFieldName('   ')).toBe(' ');
  });

  it('handles non-string input defensively', () => {
    expect(sanitizeWireFieldName(null as unknown as string)).toBe(' ');
    expect(sanitizeWireFieldName(undefined as unknown as string)).toBe(' ');
  });

  it('preserves Unicode / CJK / emoji unchanged', () => {
    expect(sanitizeWireFieldName('reviewer-claude · 副 R')).toBe('reviewer-claude · 副 R');
    expect(sanitizeWireFieldName('🔍 reviewer A')).toBe('🔍 reviewer A');
  });

  it('integration with parseWirePrefix: sanitized displayName roundtrips correctly', () => {
    // 模拟 buildWireBody 拼装：sanitize displayName 后插入 wire prefix，再 parse 拿到原值
    const userTitle = "feat: [test] worktree]bar";
    const sanitized = sanitizeWireFieldName(userTitle);
    expect(sanitized).toBe("feat:  test  worktree bar");
    const wire = `[from ${sanitized} @ claude-code][msg m1][sid s1]\nbody`;
    const parsed = parseWirePrefix(wire);
    expect(parsed).not.toBeNull();
    expect(parsed?.from).toBe(sanitized);
    expect(parsed?.body).toBe('body');
  });
});
