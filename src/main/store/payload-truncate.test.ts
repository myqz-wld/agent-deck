import { describe, expect, it } from 'vitest';
import {
  PAYLOAD_LIMITS,
  safeStringifyPayload,
  safeTruncateBlob,
} from './payload-truncate';

// 注意（P9 / agent 踩坑教训）：测试断言失败时 vitest 会 dump 原值到 stderr，
// 把 13KB `'xxx...'` 完整字符串拍进对话上下文会触发 AUP classifier。
// 凡是涉及超长字符串的 case：
// - 用「max + 100」级别的偏移而非「max + 5_000」，失败 dump 体量可控
// - 断言用 `.toMatch(/regex/)` 而非 `.toContain` / `.toBe` 让失败信息少打原文
// - 长度断言只比 length，不 dump 内容

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
    const big = 'x'.repeat(PAYLOAD_LIMITS.MAX_FIELD_BYTES + 100);
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
    expect(parsed.toolResult).toMatch(/…\[truncated \d+ bytes\]$/);
    expect(parsed.toolResult.length).toBeLessThan(big.length);
  });

  it('toolResult 数组（claude-code block 数组，简单形态）按 element.text 截断', () => {
    const big = 'y'.repeat(PAYLOAD_LIMITS.MAX_FIELD_BYTES + 100);
    const payload = {
      toolName: 'Bash',
      toolResult: [
        { type: 'text', text: big },
        { type: 'text', text: 'short' },
      ],
    };
    const out = safeStringifyPayload(payload);
    const parsed = JSON.parse(out) as { toolResult: Array<{ text: string }> };
    expect(parsed.toolResult[0].text).toMatch(/…\[truncated \d+ bytes\]$/);
    expect(parsed.toolResult[1].text).toBe('short');
  });

  it('toolResult 数组（嵌套形态：{type, content:[{text}]}）也能递归截大字段（REVIEW_4 H3）', () => {
    const big = 'z'.repeat(PAYLOAD_LIMITS.MAX_FIELD_BYTES + 100);
    const payload = {
      toolName: 'mcp__server__Tool',
      toolResult: [
        {
          type: 'tool_result',
          content: [
            { type: 'text', text: big },
            { type: 'text', text: 'kept' },
          ],
        },
      ],
    };
    const out = safeStringifyPayload(payload);
    const parsed = JSON.parse(out) as {
      toolResult: Array<{ type: string; content: Array<{ text: string }> }>;
    };
    expect(parsed.toolResult[0].type).toBe('tool_result');
    expect(parsed.toolResult[0].content[0].text).toMatch(/…\[truncated \d+ bytes\]$/);
    expect(parsed.toolResult[0].content[1].text).toBe('kept');
  });

  it('UTF-8 字节预算：中文 toolResult 按字节而非 length 截（REVIEW_4 H3）', () => {
    // 中文 utf-8 单字符 3 字节；length 8K 但字节 24K，必须按字节截
    const big = '中'.repeat(PAYLOAD_LIMITS.MAX_FIELD_BYTES);
    const payload = { toolName: 'Bash', toolResult: big };
    const out = safeStringifyPayload(payload);
    const parsed = JSON.parse(out) as { toolResult: string };
    // 必须被截（按字节判定 24K > 8K）
    expect(parsed.toolResult).toMatch(/…\[truncated \d+ bytes\]$/);
    // 截后字节数（≤ MAX + marker 文案长度）必须远小于原始字节数
    const truncatedBytes = Buffer.byteLength(parsed.toolResult, 'utf8');
    const originalBytes = Buffer.byteLength(big, 'utf8');
    expect(truncatedBytes).toBeLessThan(originalBytes);
    expect(truncatedBytes).toBeLessThanOrEqual(PAYLOAD_LIMITS.MAX_FIELD_BYTES + 64);
  });

  it('UTF-8 安全切：emoji 4 字节 sequence 不会被切出孤儿字节（REVIEW_4 H3）', () => {
    // 🦄 utf-8 是 f0 9f a6 84 (4 字节)；如果切到字节 1/2/3 中间，旧实现会输出 replacement char
    // 用 `(emoji × N) + 中` 让总字节刚好超过 8K，强制走截断路径
    const emojiCount = Math.ceil(PAYLOAD_LIMITS.MAX_FIELD_BYTES / 4) + 50;
    const big = '🦄'.repeat(emojiCount);
    const payload = { toolName: 'Bash', toolResult: big };
    const out = safeStringifyPayload(payload);
    const parsed = JSON.parse(out) as { toolResult: string };
    // 关键断言：截后内容里不能包含 unicode replacement char (U+FFFD)
    // 旧实现用 string.length / .slice 会把 🦄 切成两半，下游 JSON.parse 后变 �
    expect(parsed.toolResult).not.toContain('�');
    // 也不能出现任何 lone surrogate（high surrogate D800-DBFF / low surrogate DC00-DFFF 单独出现）
    for (let i = 0; i < parsed.toolResult.length; i++) {
      const code = parsed.toolResult.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        // high surrogate —— 下一个 charCode 必须是 low surrogate
        const next = parsed.toolResult.charCodeAt(i + 1);
        expect(next).toBeGreaterThanOrEqual(0xdc00);
        expect(next).toBeLessThanOrEqual(0xdfff);
        i++; // 跳过配对的 low surrogate
      } else {
        // low surrogate 不该单独出现
        expect(code).not.toSatisfy(
          (c: number) => c >= 0xdc00 && c <= 0xdfff,
          `lone low surrogate at index ${i}`,
        );
      }
    }
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
    expect(out.length).toBeLessThanOrEqual(PAYLOAD_LIMITS.MAX_PAYLOAD_BYTES + 8_192);
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

  it('超阈值 blob 尾切并附 marker（按字节单位，REVIEW_4 H3）', () => {
    const big = 'a'.repeat(PAYLOAD_LIMITS.MAX_PAYLOAD_BYTES + 100);
    const out = safeTruncateBlob(big);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThan(big.length);
    expect(out!).toMatch(/…\[truncated \d+ bytes\]$/);
  });

  it('UTF-8 blob：中文 256K length（≈ 768K 字节）也被截到字节阈值下', () => {
    // length 256K 但字节 768K，必须按字节截
    const big = '中'.repeat(PAYLOAD_LIMITS.MAX_PAYLOAD_BYTES);
    const out = safeTruncateBlob(big);
    expect(out).not.toBeNull();
    expect(out!).toMatch(/…\[truncated \d+ bytes\]$/);
    // 截后字节数必须接近且不超阈值（marker 文案 < 64 字节）
    const truncatedBytes = Buffer.byteLength(out!, 'utf8');
    expect(truncatedBytes).toBeLessThanOrEqual(PAYLOAD_LIMITS.MAX_PAYLOAD_BYTES + 64);
  });
});
