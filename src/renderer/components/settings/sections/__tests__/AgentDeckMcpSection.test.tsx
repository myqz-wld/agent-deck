// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_SETTINGS } from '@shared/types';
import { AgentDeckMcpSection } from '../AgentDeckMcpSection';

afterEach(cleanup);

describe('AgentDeckMcpSection tool inventory', () => {
  it('shows 19 core tools and 14 adapter-scoped browser tools', () => {
    render(
      <AgentDeckMcpSection settings={DEFAULT_SETTINGS} update={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Agent Deck MCP' }));

    const summary = screen.getByText('查看工具清单（19 个核心 + 14 个 Browser）');
    const names = [...summary.closest('details')!.querySelectorAll('code')]
      .map((node) => node.textContent)
      .filter((name) => name !== 'browser_*');
    expect(names).toContain('list_session_events');
    expect(names).toContain('browser_open');
    expect(names).toContain('browser_evaluate');
    expect(names).toHaveLength(33);
  });
});
