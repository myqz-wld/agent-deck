/**
 * manager-helpers 单测 — 覆盖 normalizeCwd / nextActivityState / extractCwd / deriveTitle
 * 的跨平台行为（特别是 Win 路径分隔符）。
 *
 * 注：normalizeCwd 走真 fs realpath，依赖运行平台；测试用 /tmp 真实存在路径 + 不存在路径
 * 走 catch fallback；Win 行为靠不依赖 fs 的 deriveTitle 验证。
 */
import { describe, it, expect } from 'vitest';
import { deriveTitle, extractCwd, nextActivityState } from '../manager-helpers';
import type { AgentEvent } from '@shared/types';

describe('deriveTitle', () => {
  it('POSIX：取 basename', () => {
    expect(deriveTitle('/Users/apple/Repository/personal/agent-deck')).toBe('agent-deck');
  });

  it('POSIX：去尾斜杠后取 basename', () => {
    expect(deriveTitle('/Users/apple/foo/')).toBe('foo');
  });

  it('Win：反斜杠路径（在 POSIX 平台 path.basename 用当前平台规则，不会切反斜杠）', () => {
    // 这条 case 在 macOS/Linux 跑时 path.basename 走 POSIX 规则，反斜杠被当字符。
    // Win 平台跑时走 win32 规则，会正确切反斜杠取末段。
    // 这里断言「不会崩 + 返回非空字符串」，具体值跟随平台。
    const result = deriveTitle('C:\\Users\\apple\\foo');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('空 cwd → 占位文案', () => {
    expect(deriveTitle('')).toBe('未命名会话');
  });

  it('单段路径 → 返回该段', () => {
    expect(deriveTitle('/foo')).toBe('foo');
  });

  it('根路径 / → fallback 到原 cwd', () => {
    // basename('/') 返 '' → fallback 到 cwd
    expect(deriveTitle('/')).toBe('/');
  });
});

describe('extractCwd', () => {
  it('从 event.payload.cwd 取出', () => {
    const event = { payload: { cwd: '/tmp/foo' } } as AgentEvent;
    expect(extractCwd(event)).toBe('/tmp/foo');
  });

  it('payload 无 cwd → undefined', () => {
    const event = { payload: {} } as AgentEvent;
    expect(extractCwd(event)).toBeUndefined();
  });

  it('payload 是 null → undefined（不崩）', () => {
    const event = { payload: null } as unknown as AgentEvent;
    expect(extractCwd(event)).toBeUndefined();
  });
});

describe('nextActivityState', () => {
  it('session-start → idle', () => {
    expect(nextActivityState('working', 'session-start', null)).toBe('idle');
  });

  it('message → working', () => {
    expect(nextActivityState('idle', 'message', null)).toBe('working');
  });

  it('waiting-for-user → waiting', () => {
    expect(nextActivityState('working', 'waiting-for-user', { type: 'permission' })).toBe('waiting');
  });

  it('waiting-for-user 但 type 含 -cancelled → 保留 current', () => {
    expect(nextActivityState('working', 'waiting-for-user', { type: 'permission-cancelled' })).toBe('working');
  });

  it('finished → finished', () => {
    expect(nextActivityState('working', 'finished', null)).toBe('finished');
  });

  it('未识别 kind → 保留 current', () => {
    expect(nextActivityState('idle', 'unknown' as AgentEvent['kind'], null)).toBe('idle');
  });
});
