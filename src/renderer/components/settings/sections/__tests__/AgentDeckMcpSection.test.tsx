// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SETTINGS } from '@shared/types';
import { AgentDeckMcpSection } from '../AgentDeckMcpSection';

afterEach(cleanup);

describe('AgentDeckMcpSection tool inventory', () => {
  it('shows 19 core tools', () => {
    const { container } = render(
      <AgentDeckMcpSection settings={DEFAULT_SETTINGS} update={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Agent Deck MCP' }));

    expect(container.textContent).toContain(
      '让 Claude Code、Codex CLI、Grok Build 等 MCP 客户端跨会话协作、展示计划和 diff，并管理任务与 Issue。',
    );
    expect(container.textContent).toContain('Codex CLI 和 Grok Build 自动连接');
    expect(container.textContent).toContain(
      '首次启动时自动生成并保存。Codex CLI 会读取环境变量',
    );

    const summary = screen.getByText('查看工具清单（19 个核心工具）');
    expect(summary.closest('details')!.textContent).not.toContain('Browser：');
    const names = [...summary.closest('details')!.querySelectorAll('code')]
      .map((node) => node.textContent);
    expect(names).toContain('list_session_events');
    expect(names).not.toContain('browser_open');
    expect(names).toHaveLength(19);
  });
});
