import { describe, expect, it } from 'vitest';
import {
  PAYLOAD_LIMITS,
  safeStringifyPayload,
  safeTruncateBlob,
} from './payload-truncate';

describe('safeStringifyPayload', () => {
  it('小 payload 直接返回原序列化结果', () => {
    const payload = { kind: 'session-start', cwd: '/tmp/foo' };
    const out = safeStringifyPayload(payload);
    expect(out).toBe(JSON.stringify(payload));
    expect(JSON.parse(out)).toEqual(payload);
  });

  it('null payload 序列化为 "null"（与历史 JSON.stringify(payload ?? null) 行为一致）', () => {
    expect(safeStringifyPayload(null)).toBe('null');
    expect(safeStringifyPayload(undefined)).toBe('null');
  });

  it('单个 known-large 字符串字段超阈值时只截该字段，其它字段保留', () => {
    const big = 'x'.repeat(PAYLOAD_LIMITS.MAX_FIELD_BYTES + 5_000);
    const payload = {
      toolName: 'Bash',
      toolUseId: 'tu_1',
      toolResult: big,
      meta: { command: 'ls -la' },
    };
    const out = safeStringifyPayload(payload);
    const parsed = JSON.parse(out) as typeof payload;
    expect(parsed.toolName).toBe('Bash');
    expect(parsed.toolUseId).toBe('tu_1');
    expect(parsed.meta).toEqual({ command: 'ls -la' });
    expect(parsed.toolResult).toContain('…[truncated');
    expect(parsed.toolResult.length).toBeLessThan(big.length);
  });

  it('toolResult 数组（claude-code block 数组）按 element.text 截断', () => {
    const big = 'y'.repeat(PAYLOAD_LIMITS.MAX_FIELD_BYTES + 1_000);
    const payload = {
      toolName: 'Bash',
      toolResult: [
        { type: 'text', text: big },
        { type: 'text', text: 'short' },
      ],
    };
    const out = safeStringifyPayload(payload);
    const parsed = JSON.parse(out) as { toolResult: Array<{ text: string }> };
    expect(parsed.toolResult[0].text).toContain('…[truncated');
    expect(parsed.toolResult[1].text).toBe('short');
  });

  it('整体仍 > 256KB 时降级为 marker payload', () => {
    // 构造一个大量小字段，shrink 大字段也救不了
    const obj: Record<string, string> = {};
    for (let i = 0; i < 6_000; i++) {
      obj[`k${i}`] = 'v'.repeat(80); // 每对 ~88 字节，6000 对 ~528KB 远超 256KB
    }
    const out = safeStringifyPayload(obj);
    const parsed = JSON.parse(out) as { __truncated: boolean; __originalBytes: number };
    expect(parsed.__truncated).toBe(true);
    expect(parsed.__originalBytes).toBeGreaterThan(PAYLOAD_LIMITS.MAX_PAYLOAD_BYTES);
    expect(out.length).toBeLessThanOrEqual(PAYLOAD_LIMITS.MAX_PAYLOAD_BYTES + 8_192); // marker 自己也别太大
  });
});

describe('safeTruncateBlob', () => {
  it('null 直接返回 null', () => {
    expect(safeTruncateBlob(null)).toBeNull();
    expect(safeTruncateBlob(undefined)).toBeNull();
  });

  it('小 blob 原样返回', () => {
    expect(safeTruncateBlob('hello')).toBe('hello');
  });

  it('超阈值 blob 尾切并附 marker', () => {
    const big = 'a'.repeat(PAYLOAD_LIMITS.MAX_PAYLOAD_BYTES + 10_000);
    const out = safeTruncateBlob(big);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThan(big.length);
    expect(out!).toContain('…[truncated 10000 chars]');
  });
});
