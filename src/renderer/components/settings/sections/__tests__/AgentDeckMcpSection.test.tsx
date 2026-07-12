// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SETTINGS } from '@shared/types';
import { AgentDeckMcpSection } from '../AgentDeckMcpSection';

afterEach(cleanup);

describe('AgentDeckMcpSection tool inventory', () => {
  it('shows all 19 registered tools, including list_session_events', () => {
    render(
      <AgentDeckMcpSection settings={DEFAULT_SETTINGS} update={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Agent Deck MCP' }));

    const summary = screen.getByText('查看全部 19 个工具');
    const names = [...summary.closest('details')!.querySelectorAll('code')].map(
      (node) => node.textContent,
    );
    expect(names).toContain('list_session_events');
    expect(names).toHaveLength(19);
  });
});
