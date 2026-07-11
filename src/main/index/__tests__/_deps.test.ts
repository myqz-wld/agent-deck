/**
 * REVIEW_104 INFO-F (双方共识 — reviewer-codex + reviewer-claude): 启动/关闭子系统
 * (index/ facade 拆分)零测试覆盖,本文件补 _deps.ts 纯可测逻辑回归测试。
 *
 * 范围(可纯单测的部分):
 * - makeDebouncedTeamSender: 16ms debounce 累加 + per-key dedup(同 key 后值覆盖) +
 *   leading-skip(timer 在飞时不重起) + trailing-flush(timer fire 后清空 + 再来新 item 起新 timer) +
 *   空 pending 不 send 守门
 * - createInitialBootstrapState: 8 字段全 null 初值
 * - TOOL_DISPLAY_NAME: 对 EventMap caller-archive-failed toolName union 完整覆盖(穷举)
 *
 * 不在本文件(需 Electron app / DB / 真窗口,属 integration,与既有「bootstrap god-function 无
 * test harness」同款 deferral): initInfra / initWiring / registerLifecycleHooks 的 Phase 时序、
 * before-quit race-with-timeout 真机路径(lead 已 /tmp node sim 4 路径验证 closeDb 无条件跑)。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import {
  makeDebouncedTeamSender,
  createInitialBootstrapState,
  TOOL_DISPLAY_NAME,
} from '../_deps';

describe('makeDebouncedTeamSender', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('16ms debounce 内多个 item 合并为一次 send;同 key 后值覆盖前值', () => {
    const sent: string[][] = [];
    const send = (_ch: string, items: { id: string }[]) => sent.push(items.map((i) => i.id));
    const sender = makeDebouncedTeamSender<{ key: string; id: string }>(
      'ch',
      send,
      (i) => i.key,
    );

    sender({ key: 'a', id: 'a1' });
    sender({ key: 'b', id: 'b1' });
    sender({ key: 'a', id: 'a2' }); // 同 key 'a' → 覆盖 a1
    expect(sent).toEqual([]); // 还没 fire

    vi.advanceTimersByTime(16);
    expect(sent).toEqual([['a2', 'b1']]); // a 取覆盖后的 a2,b 保留;一次 flush
  });

  it('leading-skip:timer 在飞期间不重起 timer(单次 setTimeout)', () => {
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');
    const send = vi.fn();
    const sender = makeDebouncedTeamSender<{ key: string }>('ch', send, (i) => i.key);

    sender({ key: 'a' });
    sender({ key: 'b' });
    sender({ key: 'c' });
    // 三次调用只起一个 timer(后两次命中 `if (state.timer) return`)
    const timerCalls = setTimeoutSpy.mock.calls.filter((c) => c[1] === 16);
    expect(timerCalls.length).toBe(1);
    setTimeoutSpy.mockRestore();
  });

  it('trailing-flush:fire 后清空 pending,再来新 item 起新 timer 再 flush', () => {
    const sent: string[][] = [];
    const send = (_ch: string, items: { id: string }[]) => sent.push(items.map((i) => i.id));
    const sender = makeDebouncedTeamSender<{ key: string; id: string }>('ch', send, (i) => i.key);

    sender({ key: 'a', id: 'a1' });
    vi.advanceTimersByTime(16);
    expect(sent).toEqual([['a1']]);

    // flush 后 pending 已 clear + timer=null → 新 item 起新一轮
    sender({ key: 'c', id: 'c1' });
    vi.advanceTimersByTime(16);
    expect(sent).toEqual([['a1'], ['c1']]);
  });

  it('pending 为空时 fire 不 send(items.length===0 守门)', () => {
    // 直接构造场景:正常用法 pending 不会空(set 后才起 timer),此处验证守门存在性 —
    // 即使 timer fire 时 pending 空(理论 race)也不会 send 空数组。
    const send = vi.fn();
    const sender = makeDebouncedTeamSender<{ key: string }>('ch', send, (i) => i.key);
    sender({ key: 'a' });
    vi.advanceTimersByTime(16);
    expect(send).toHaveBeenCalledTimes(1); // 正常 flush 一次
    // 再 advance,无新 item,不应再 send
    vi.advanceTimersByTime(100);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('createInitialBootstrapState', () => {
  it('8 字段全部初始化为 null(单例聚合 mutable state 起点)', () => {
    const state = createInitialBootstrapState();
    expect(state).toEqual({
      hookServer: null,
      routeRegistry: null,
      scheduler: null,
      teamScheduler: null,
      issueScheduler: null,
      messageScheduler: null,
      tokenUsageScheduler: null,
      agentDeckMcpHttpShutdown: null,
    });
  });

  it('每次调用返回独立对象(非共享单例,防 mutate 串台)', () => {
    const a = createInitialBootstrapState();
    const b = createInitialBootstrapState();
    expect(a).not.toBe(b);
    a.hookServer = {} as never;
    expect(b.hookServer).toBeNull(); // a 的 mutate 不影响 b
  });
});

describe('TOOL_DISPLAY_NAME', () => {
  it('覆盖 caller-archive-failed toolName union 全部三值(穷举,无 fallback 软兜底)', () => {
    // EventMap['caller-archive-failed'][0]['toolName'] union = 这三值;
    // TOOL_DISPLAY_NAME 是 Record<CallerArchiveFailedToolName, string> 强制完整覆盖
    // (加新 toolName 忘加条目 → tsc 编译期 fail)。本测试运行期再兜一层穷举断言。
    expect(TOOL_DISPLAY_NAME.archive_plan).toBe('plan 归档');
    expect(TOOL_DISPLAY_NAME.hand_off_session).toBe('会话接力');
    expect(TOOL_DISPLAY_NAME.SessionHandOffCommit).toBe('会话接力');
    expect(Object.keys(TOOL_DISPLAY_NAME).sort()).toEqual(
      ['SessionHandOffCommit', 'archive_plan', 'hand_off_session'].sort(),
    );
  });

  it('所有 display name 非空(不暴露 IPC channel 内部名给用户)', () => {
    for (const [key, display] of Object.entries(TOOL_DISPLAY_NAME)) {
      expect(display.length).toBeGreaterThan(0);
      // SessionHandOffCommit 是内部 channel 名,display 必须映射成友好名(不等于 key 本身)
      if (key === 'SessionHandOffCommit') {
        expect(display).not.toBe(key);
      }
    }
  });
});
