// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/types';
import type { BackgroundTaskSnapshot } from '@shared/background-task';
import { ActivityRecordsView } from './records-view';
import { presentBackgroundTasks } from './background-task-presentation';

afterEach(cleanup);

function task(patch: Partial<BackgroundTaskSnapshot> = {}, ts = 1): AgentEvent {
  return {
    sessionId: 'session-a', agentId: 'claude-code', kind: 'background-task', ts,
    payload: { taskId: 'build', runId: 'run-2', taskType: 'local_bash',
      status: 'running', description: 'Run build checks', revision: 1, ...patch },
  };
}

function view(events: AgentEvent[]) {
  return <ActivityRecordsView events={events} loaded loadError={null} sessionId="session-a"
    agentId="claude-code" isSdk allowLocalAssets={false} />;
}

describe('background task activity', () => {
  it.each([
    ['local_bash', '后台命令'], ['local_agent', '后台子代理'],
  ])('updates one %s row through progress and completion without remounting its details', (taskType, label) => {
    const start = task({ taskType });
    const rendered = render(view([start]));
    expect(screen.getByText(`${label} · 运行中`)).toBeTruthy();
    const toggle = screen.getByRole('button', { name: new RegExp(`${label}.*展开详情`) });
    const details = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(details.hidden).toBe(true);
    fireEvent.click(toggle);
    const progress = task({ taskType, revision: 2, summary: 'Compiling the final target',
      toolUses: 3, totalTokens: 100, durationMs: 5_000, lastToolName: 'Bash' }, 2);
    rendered.rerender(view([progress, start]));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBe(details);
    expect(details.hidden).toBe(false);
    expect(screen.getByText('Compiling the final target')).toBeTruthy();
    expect(screen.getByText('工具调用 3 次')).toBeTruthy();
    const end = task({ taskType, revision: 3, status: 'completed', summary: 'All checks passed',
      outputFile: '/workspace/build.log' }, 2);
    rendered.rerender(view([end, progress, start]));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText(`${label} · 已完成`)).toBeTruthy();
    expect(screen.getByText('All checks passed')).toBeTruthy();
    expect(rendered.container.textContent).toContain('/workspace/build.log');
    expect(screen.queryByText(`${label} · 运行中`)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`${label}.*收起详情`) }));
    expect(details.hidden).toBe(true);
  });

  it('keeps failed task outcomes visible independently of a completed main turn', () => {
    render(view([task({ status: 'failed', error: 'Compiler exited with code 2' }), {
      sessionId: 'session-a', agentId: 'claude-code', kind: 'finished', ts: 2,
      payload: { ok: true, subtype: 'success' },
    }]));
    expect(screen.getByText('后台命令 · 失败')).toBeTruthy();
    expect(screen.getByText('Compiler exited with code 2')).toBeTruthy();
    expect(screen.getByText('一轮完成')).toBeTruthy();
  });

  it('selects a resumed run over late events from the previous run', () => {
    const resumed = task({ runId: 'run-3', revision: 1, description: 'Resumed checks' }, 20);
    const oldResult = task({ status: 'completed', revision: 99 }, 30);
    expect(presentBackgroundTasks([oldResult, resumed, task()])).toEqual([resumed]);
    expect(presentBackgroundTasks([task(), resumed, oldResult])).toEqual([resumed]);
  });

  it('allows a new process without native run IDs to replace an older revision', () => {
    const old = task({ runId: undefined, revision: 20 }, 1);
    const current = task({ runId: undefined, revision: 1 }, 10);
    expect(presentBackgroundTasks([current, old])).toEqual([current]);
  });

  it.each(['session-start', 'session-end'] as const)(
    'does not claim that historical background work is still running after %s', (kind) => {
      const boundary: AgentEvent = { sessionId: 'session-a', agentId: 'claude-code', kind, ts: 10, payload: {} };
      const presented = presentBackgroundTasks([task(), boundary]);
      expect(presented[0].payload).toMatchObject({ status: 'unknown' });
      const completed = task({ status: 'completed' });
      expect(presentBackgroundTasks([completed, boundary])[0]).toBe(completed);
    },
  );

  it('hides ambient tasks after a visibility update without merging different owners', () => {
    const start = task();
    const hidden = task({ revision: 2, hidden: true }, 2);
    expect(presentBackgroundTasks([hidden, start])).toEqual([]);
    const otherSession = { ...start, sessionId: 'session-b' };
    const otherAdapter = { ...start, agentId: 'other-adapter' };
    expect(presentBackgroundTasks([start, otherSession, otherAdapter])).toHaveLength(3);
  });

  it('tolerates malformed history payloads without rendering objects as React children', () => {
    const invalid = { ...task(), payload: { taskId: 'build', status: { toString: null }, description: {},
      summary: ['bad'], error: {}, totalTokens: -1, toolUses: {}, revision: 'bad' } };
    const rendered = render(view([invalid]));
    expect(screen.getByText('后台任务 · 状态待确认')).toBeTruthy();
    expect(rendered.container.textContent).not.toContain('[object Object]');
    rendered.rerender(view([{ ...invalid, payload: null }]));
    expect(screen.queryByRole('listitem')).toBeNull();
  });
});
