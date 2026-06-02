// @vitest-environment happy-dom
/**
 * useIssuesBridge 常驻订阅回归测试（修「切到问题页状态不刷新」bug）。
 *
 * 背景：原先 onIssueChanged 订阅写在 IssuesPanel 组件 useEffect 里，App 按 view 条件渲染 panel，
 * 切走 tab 即 unmount → 订阅被拆除 → 期间的 issue-changed 事件（典型 MCP「起新会话解决」回写
 * status / update_issue_status 翻 resolved）全漏 → 切回时 store 仍是旧状态。修法：把订阅上移到
 * App 常驻挂载的 useIssuesBridge，事件永不漏。
 *
 * 本文件验三条 bug 直接相关行为：
 *  ① mount 即订阅 window.api.onIssueChanged（修复前订阅依附组件生命周期）
 *  ② 收到 created/updated/appended event（带 issue）→ store.upsertIssue（状态实时落 store）
 *  ③ 收到 hardDeleted event → store.removeIssue
 *  ④ unmount → 调用 onIssueChanged 返回的 off()（不泄漏订阅）
 *
 * window.api mock 策略：本仓库渲染层测试尚无 window.api stub 先例，这里用 vi.stubGlobal 挂一个
 * 最小 window.api（仅 onIssueChanged），记录注册的 callback + off spy，手动 emit 驱动 store。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { IssueChangedEvent, IssueRecord } from '@shared/types';
import { useIssuesBridge } from '../use-issues-bridge';
import { useIssuesStore } from '@renderer/stores/issues-store';

function makeIssue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    id: 'i1',
    title: 'T',
    description: 'D',
    repro: null,
    kind: 'follow-up',
    status: 'open',
    severity: 'medium',
    sourceSessionId: 's1',
    cwd: null,
    logsRef: null,
    resolutionSessionId: null,
    labels: [],
    createdAt: 1000,
    updatedAt: 1000,
    resolvedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

/** 捕获 useIssuesBridge 注册的 issue-changed callback + off spy。 */
let emitIssueChanged: ((e: IssueChangedEvent) => void) | null = null;
let offSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  emitIssueChanged = null;
  offSpy = vi.fn();
  // 每个用例重置 store（zustand 是 module 级单例，跨用例会串）
  useIssuesStore.setState({ issues: new Map(), selectedIssueId: null });
  vi.stubGlobal('window', {
    api: {
      onIssueChanged: (cb: (e: IssueChangedEvent) => void) => {
        emitIssueChanged = cb;
        return offSpy;
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useIssuesBridge — 常驻订阅生命周期', () => {
  it('mount 即订阅 onIssueChanged（callback 被注册）', () => {
    expect(emitIssueChanged).toBeNull();
    renderHook(() => useIssuesBridge());
    expect(emitIssueChanged).not.toBeNull();
  });

  it('unmount 调用 off()（不泄漏订阅）', () => {
    const { unmount } = renderHook(() => useIssuesBridge());
    expect(offSpy).not.toHaveBeenCalled();
    unmount();
    expect(offSpy).toHaveBeenCalledTimes(1);
  });
});

describe('useIssuesBridge — 事件 → store 派发', () => {
  it('updated event（带 issue）→ upsert 进 store，状态实时刷新', () => {
    renderHook(() => useIssuesBridge());
    const resolved = makeIssue({ status: 'resolved', updatedAt: 2000 });
    act(() => {
      emitIssueChanged!({
        kind: 'updated',
        issueId: 'i1',
        issue: resolved,
        sourceSessionId: 's1',
        ts: 2000,
      });
    });
    // ★ bug 核心：状态翻 resolved 的 event 直接落 store（修复前 unmount 期间会漏）
    expect(useIssuesStore.getState().issues.get('i1')?.status).toBe('resolved');
  });

  it('created event（带 issue）→ upsert 新 issue 进 store', () => {
    renderHook(() => useIssuesBridge());
    const fresh = makeIssue({ id: 'i2', title: 'new' });
    act(() => {
      emitIssueChanged!({
        kind: 'created',
        issueId: 'i2',
        issue: fresh,
        sourceSessionId: 's1',
        ts: 1000,
      });
    });
    expect(useIssuesStore.getState().issues.get('i2')?.title).toBe('new');
  });

  it('hardDeleted event → 从 store 移除', () => {
    // 先放一条进 store
    useIssuesStore.getState().upsertIssue(makeIssue());
    renderHook(() => useIssuesBridge());
    expect(useIssuesStore.getState().issues.has('i1')).toBe(true);
    act(() => {
      emitIssueChanged!({
        kind: 'hardDeleted',
        issueId: 'i1',
        issue: null,
        sourceSessionId: 's1',
        ts: 3000,
      });
    });
    expect(useIssuesStore.getState().issues.has('i1')).toBe(false);
  });
});
