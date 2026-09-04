// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AssetMeta } from '@shared/types';
import { AssetsTab } from './AssetsTab';

afterEach(cleanup);

function bundledAgent(): AssetMeta {
  return {
    kind: 'agent',
    source: 'bundled',
    adapter: 'claude-code',
    name: 'reviewer-claude',
    qualifiedName: 'agent-deck:claude-code:reviewer-claude',
    description: 'Bundled Agent',
    absPath: '/tmp/reviewer-claude.md',
  };
}

describe('AssetsTab', () => {
  it('只展示内置资产及其查看入口', () => {
    render(
      <AssetsTab
        kind="agent"
        adapter="claude-code"
        bundled={[bundledAgent()]}
        onView={vi.fn()}
      />,
    );

    expect(screen.getByText('内置')).toBeTruthy();
    expect(screen.getByText('agent-deck:claude-code:reviewer-claude')).toBeTruthy();
    expect(screen.queryByText('用户与 Plugin（只读）')).toBeNull();
    expect(screen.queryByText('~/.claude/agents/')).toBeNull();
    expect(screen.queryByRole('button', { name: /新建/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /编辑/ })).toBeNull();
    expect(screen.getByRole('button', { name: '查看' })).toBeTruthy();
  });

  it('内置资产为空时显示空状态', () => {
    render(
      <AssetsTab
        kind="skill"
        adapter="codex-cli"
        bundled={[]}
        onView={vi.fn()}
      />,
    );

    expect(screen.getByText('内置（只读）')).toBeTruthy();
    expect(screen.getByText('（无）')).toBeTruthy();
  });

  it('initially bounds a large catalog and reveals it in fixed pages', () => {
    const bundled = Array.from({ length: 120 }, (_, index) => ({
      ...bundledAgent(),
      name: `agent-${index}`,
      qualifiedName: `agent-deck:claude-code:agent-${index}`,
      absPath: `/safe/agent-${index}.md`,
    }));
    render(
      <AssetsTab kind="agent" adapter="claude-code" bundled={bundled} onView={vi.fn()} />,
    );

    expect(screen.getAllByRole('button', { name: '查看' })).toHaveLength(50);
    fireEvent.click(screen.getByRole('button', { name: '再显示 50 项' }));
    expect(screen.getAllByRole('button', { name: '查看' })).toHaveLength(100);
    fireEvent.click(screen.getByRole('button', { name: '再显示 20 项' }));
    expect(screen.getAllByRole('button', { name: '查看' })).toHaveLength(120);
  });
});
