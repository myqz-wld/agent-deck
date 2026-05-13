import { describe, expect, it } from 'vitest';
import { parseWirePrefix } from '../wire-prefix';

describe('parseWirePrefix', () => {
  it('parses standard prefix with msgId (current B7+ format)', () => {
    const text = '[from Reviewer Claude @ claude-code][msg msg-abc-123]\nHello teammate, please review this.';
    const parsed = parseWirePrefix(text);
    expect(parsed).toEqual({
      from: 'Reviewer Claude',
      adapter: 'claude-code',
      msgId: 'msg-abc-123',
      body: 'Hello teammate, please review this.',
    });
  });

  it('parses old prefix without msgId (legacy events)', () => {
    const text = '[from Lead @ codex-cli]\nLegacy message body';
    const parsed = parseWirePrefix(text);
    expect(parsed).toEqual({
      from: 'Lead',
      adapter: 'codex-cli',
      body: 'Legacy message body',
    });
    expect(parsed?.msgId).toBeUndefined();
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
  });

  it('preserves multi-line body intact', () => {
    const text = '[from R @ claude-code][msg m1]\nLine 1\nLine 2\n\nLine 4 (after blank)';
    const parsed = parseWirePrefix(text);
    expect(parsed?.body).toBe('Line 1\nLine 2\n\nLine 4 (after blank)');
  });

  it('handles displayName with spaces and special chars (no `]`)', () => {
    const text = '[from Claude Code · 副 reviewer @ claude-code][msg m1]\nBody';
    const parsed = parseWirePrefix(text);
    expect(parsed?.from).toBe('Claude Code · 副 reviewer');
    expect(parsed?.adapter).toBe('claude-code');
  });

  it('returns null when text does not start with `[from `', () => {
    // 防御：startsWith fast-path 已挡，但 regex 也应自然不匹配
    expect(parseWirePrefix('xx[from Y @ z][msg m]\nbody')).toBeNull();
    expect(parseWirePrefix(' [from Y @ z][msg m]\nbody')).toBeNull(); // 前导空格不允许
  });

  it('handles fallback displayName format (`<adapterId>:<sid 前 8>`)', () => {
    // 当 team_member.display_name 缺失时，buildWireBody 用 `${adapterId}:${sid.slice(0,8)}`
    const text = '[from claude-code:abc12345 @ claude-code][msg m1]\nFallback display';
    const parsed = parseWirePrefix(text);
    expect(parsed?.from).toBe('claude-code:abc12345');
  });
});
