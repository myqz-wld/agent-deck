// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SETTINGS } from '@shared/types';
import { AgentDeckMcpSection } from '../AgentDeckMcpSection';

afterEach(cleanup);

describe('AgentDeckMcpSection tool inventory', () => {
  it('shows 19 core tools and the unified Browser skill plus CLI route', () => {
    const { container } = render(
      <AgentDeckMcpSection settings={DEFAULT_SETTINGS} update={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Agent Deck MCP' }));

    expect(container.textContent).toContain(
      '让 Claude Code、Codex CLI、Grok Build 等 MCP 客户端跨会话协作、展示计划和 diff，并管理任务与 Issue。',
    );
    expect(container.textContent).toContain('Browser：不再属于本地 Agent Deck MCP 工具');
    expect(container.textContent).toContain('Claude Code、Codex CLI 和 Grok Build 统一通过');
    expect(container.textContent).toContain('内置 Browser Skill 与会话专属');
    expect(container.textContent).toContain('Agent 不需要传递会话 ID');
    expect(container.textContent).toContain('Codex CLI 和 Grok Build 自动连接');
    expect(container.textContent).toContain(
      '首次启动时自动生成并保存。Codex CLI 会读取环境变量',
    );

    const summary = screen.getByText('查看工具清单（19 个核心工具）');
    const names = [...summary.closest('details')!.querySelectorAll('code')]
      .map((node) => node.textContent);
    expect(names).toContain('list_session_events');
    expect(names).toContain('agent-deck-browser');
    expect(names).not.toContain('browser_open');
    expect(names.filter((name) => name !== 'agent-deck-browser')).toHaveLength(19);
  });
});
