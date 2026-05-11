/**
 * ansi-parser.ts 单测（R4·F3）。
 *
 * 守门：
 * - stripAnsi 各 escape 序列：CSI / SGR / OSC / 复合 / 边界（无 escape / 全 escape / \r\n 保留）
 * - PtyOutputBuffer：push 累积、超 capacity 截断、size 准确、suffix 末尾稳定
 * - IdleDetector：onData 启动 timer、onData reset、idleQuietMs 后 fire callback、
 *   promptSuffixRegex 二次校验（match → fire / 不 match → 不 fire）、dispose 取消 timer
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stripAnsi, PtyOutputBuffer, IdleDetector } from '../ansi-parser';

// ────────────────────────────────────────────────────────────────────────────
// stripAnsi
// ────────────────────────────────────────────────────────────────────────────

describe('stripAnsi', () => {
  it('removes basic SGR color codes', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
    expect(stripAnsi('\x1b[1;32mbold-green\x1b[0m')).toBe('bold-green');
  });

  it('removes CSI cursor / clear codes', () => {
    expect(stripAnsi('\x1b[2J\x1b[Hcleared')).toBe('cleared');
    expect(stripAnsi('hello\x1b[5A\x1b[K')).toBe('hello');
  });

  it('removes OSC title sequences (terminated by BEL)', () => {
    expect(stripAnsi('\x1b]0;window-title\x07ok')).toBe('ok');
  });

  it('preserves \\r \\n \\t (line/tab control retained for UI)', () => {
    expect(stripAnsi('a\nb\r\nc\td')).toBe('a\nb\r\nc\td');
  });

  it('returns input unchanged when no escape present', () => {
    expect(stripAnsi('plain text 123')).toBe('plain text 123');
  });

  it('handles empty string', () => {
    expect(stripAnsi('')).toBe('');
  });

  it('handles input that is purely escape sequences (returns empty)', () => {
    expect(stripAnsi('\x1b[31m\x1b[0m\x1b[1m')).toBe('');
  });

  it('handles aider-style mixed prompt (color + plain + prompt suffix)', () => {
    // 模拟 aider 的常见 prompt：颜色字符 + 文字 + `> ` suffix
    const raw = '\x1b[36m> \x1b[0m';
    expect(stripAnsi(raw)).toBe('> ');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// PtyOutputBuffer
// ────────────────────────────────────────────────────────────────────────────

describe('PtyOutputBuffer', () => {
  it('accumulates pushes under capacity', () => {
    const buf = new PtyOutputBuffer(100);
    buf.push('hello');
    buf.push(' world');
    expect(buf.toString()).toBe('hello world');
    expect(buf.size()).toBe(11);
  });

  it('truncates from head when exceeding capacity', () => {
    const buf = new PtyOutputBuffer(10);
    buf.push('aaaaa');
    buf.push('bbbbb');
    buf.push('cccccc'); // 加进去后总长 16 > 10 → drop 'aaaaa' (剩 11) → 还 > 10 → drop 'bbbbb' (剩 6)
    expect(buf.toString()).toBe('cccccc');
    expect(buf.size()).toBe(6);
  });

  it('handles empty push (no-op)', () => {
    const buf = new PtyOutputBuffer(10);
    buf.push('');
    expect(buf.toString()).toBe('');
    expect(buf.size()).toBe(0);
  });

  it('clear resets to empty', () => {
    const buf = new PtyOutputBuffer(100);
    buf.push('something');
    buf.clear();
    expect(buf.toString()).toBe('');
    expect(buf.size()).toBe(0);
  });

  it('preserves regex match on tail after truncation', () => {
    const buf = new PtyOutputBuffer(10);
    buf.push('garbage-history-stuff');
    buf.push('done\n> '); // tail
    // 实际 buf 内容截后是 'one\n> '（因为 garbage-history-stuff(20) + done\n> (6) = 26，
    // 截到剩 ≤ 10：先 drop 第一个 chunk 'garbage-history-stuff' → 剩 6 → 不再 drop）
    expect(buf.toString().endsWith('> ')).toBe(true);
    expect(/\>\s*$/.test(buf.toString())).toBe(true);
  });

  it('preserves tail when SINGLE chunk exceeds capacity (REVIEW_24 HIGH-1 regression)', () => {
    // reviewer-claude 实测复现：单 chunk ≥ capacity 时旧实现整个 buffer 归零 →
    // promptSuffixRegex 末尾匹配彻底失效（aider --no-stream 一次性 emit 5-15KB chunk + 末尾 `> `）。
    const buf = new PtyOutputBuffer(10);
    buf.push('a'.repeat(20) + 'TAIL> '); // 整 chunk = 26 > 10
    expect(buf.size()).toBe(10);
    expect(buf.toString().endsWith('TAIL> ')).toBe(true);
    expect(/\>\s*$/.test(buf.toString())).toBe(true);
  });

  it('handles single chunk equal to capacity (boundary)', () => {
    const buf = new PtyOutputBuffer(10);
    buf.push('1234567890'); // exactly capacity
    expect(buf.toString()).toBe('1234567890');
    expect(buf.size()).toBe(10);
  });

  it('REVIEW_24 HIGH-1 — buf still matches promptSuffixRegex even when long aider answer arrives in one chunk', () => {
    const buf = new PtyOutputBuffer(8192);
    // 模拟 aider 在 --no-stream 模式下一次性 emit 9KB 答复 + 末尾 prompt
    const longAnswer = 'lorem ipsum '.repeat(800); // ~9600 char
    buf.push(longAnswer + '\n> ');
    expect(buf.size()).toBe(8192);
    expect(buf.toString().endsWith('> ')).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// IdleDetector
// ────────────────────────────────────────────────────────────────────────────

describe('IdleDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onIdle after idleQuietMs since last onData', () => {
    let fired = 0;
    const buf = new PtyOutputBuffer();
    const det = new IdleDetector({
      idleQuietMs: 1000,
      promptSuffixRegex: '',
      onIdle: () => {
        fired++;
      },
    });
    buf.push('hi');
    det.onData(buf);
    vi.advanceTimersByTime(999);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(2);
    expect(fired).toBe(1);
  });

  it('resets timer when new onData arrives (debounce)', () => {
    let fired = 0;
    const buf = new PtyOutputBuffer();
    const det = new IdleDetector({
      idleQuietMs: 1000,
      promptSuffixRegex: '',
      onIdle: () => {
        fired++;
      },
    });
    buf.push('first');
    det.onData(buf);
    vi.advanceTimersByTime(800);
    buf.push('second');
    det.onData(buf); // reset
    vi.advanceTimersByTime(800);
    expect(fired).toBe(0); // first onData 后 1600ms 但 second 后只 800ms
    vi.advanceTimersByTime(300);
    expect(fired).toBe(1); // second 后 1100ms → 触发
  });

  it('does not fire when promptSuffixRegex set but tail does not match', () => {
    let fired = 0;
    const buf = new PtyOutputBuffer();
    const det = new IdleDetector({
      idleQuietMs: 500,
      promptSuffixRegex: '\\>\\s*$',
      onIdle: () => {
        fired++;
      },
    });
    buf.push('thinking...');
    det.onData(buf);
    vi.advanceTimersByTime(600);
    expect(fired).toBe(0); // tail 末尾不是 `> `
  });

  it('fires when promptSuffixRegex matches tail', () => {
    let fired = 0;
    const buf = new PtyOutputBuffer();
    const det = new IdleDetector({
      idleQuietMs: 500,
      promptSuffixRegex: '\\>\\s*$',
      onIdle: () => {
        fired++;
      },
    });
    buf.push('done\n> ');
    det.onData(buf);
    vi.advanceTimersByTime(600);
    expect(fired).toBe(1);
  });

  it('falls back to pure idleQuietMs when promptSuffixRegex is empty', () => {
    let fired = 0;
    const buf = new PtyOutputBuffer();
    const det = new IdleDetector({
      idleQuietMs: 500,
      promptSuffixRegex: '',
      onIdle: () => {
        fired++;
      },
    });
    buf.push('anything');
    det.onData(buf);
    vi.advanceTimersByTime(600);
    expect(fired).toBe(1); // 没 regex → 纯 idleQuietMs 触发
  });

  it('falls back gracefully on invalid promptSuffixRegex', () => {
    let fired = 0;
    const buf = new PtyOutputBuffer();
    const det = new IdleDetector({
      idleQuietMs: 500,
      promptSuffixRegex: '[invalid(', // 故意不合法
      onIdle: () => {
        fired++;
      },
    });
    buf.push('anything');
    det.onData(buf);
    vi.advanceTimersByTime(600);
    expect(fired).toBe(1); // invalid regex → 退回纯 idleQuietMs
  });

  it('dispose cancels pending timer (no fire)', () => {
    let fired = 0;
    const buf = new PtyOutputBuffer();
    const det = new IdleDetector({
      idleQuietMs: 500,
      promptSuffixRegex: '',
      onIdle: () => {
        fired++;
      },
    });
    buf.push('x');
    det.onData(buf);
    det.dispose();
    vi.advanceTimersByTime(2000);
    expect(fired).toBe(0);
  });

  it('cancel allows reusable detector (next onData restart)', () => {
    let fired = 0;
    const buf = new PtyOutputBuffer();
    const det = new IdleDetector({
      idleQuietMs: 500,
      promptSuffixRegex: '',
      onIdle: () => {
        fired++;
      },
    });
    buf.push('x');
    det.onData(buf);
    det.cancel();
    vi.advanceTimersByTime(600);
    expect(fired).toBe(0);
    // 重新 onData 仍能正常工作
    buf.push('y');
    det.onData(buf);
    vi.advanceTimersByTime(600);
    expect(fired).toBe(1);
  });

  it('catches throwing onIdle callback (does not crash bridge)', () => {
    const buf = new PtyOutputBuffer();
    const det = new IdleDetector({
      idleQuietMs: 500,
      promptSuffixRegex: '',
      onIdle: () => {
        throw new Error('boom');
      },
    });
    buf.push('x');
    det.onData(buf);
    expect(() => vi.advanceTimersByTime(600)).not.toThrow();
  });
});
