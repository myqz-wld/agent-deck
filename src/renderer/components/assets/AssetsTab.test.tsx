// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AssetMeta } from '@shared/types';
import { AssetsTab } from './AssetsTab';

afterEach(cleanup);

function userAgent(): AssetMeta {
  return {
    kind: 'agent',
    source: 'user',
    adapter: 'claude-code',
    origin: 'direct',
    runtimeName: 'user-agent',
    name: 'user-agent',
    qualifiedName: 'user-agent',
    description: 'User-managed Agent',
    absPath: '/tmp/user-agent.md',
  };
}

describe('AssetsTab', () => {
  it('只读展示用户资产且不提供新建或编辑入口', () => {
    render(
      <AssetsTab
        kind="agent"
        adapter="claude-code"
        bundled={[]}
        user={[userAgent()]}
        onView={vi.fn()}
      />,
    );

    expect(screen.getByText('用户与 Plugin（只读）')).toBeTruthy();
    expect(screen.getByText('~/.claude/agents/')).toBeTruthy();
    expect(screen.getByText('只读')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /新建/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /编辑/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /展开查看/ })).toBeNull();
    expect(screen.getByRole('button', { name: '查看' })).toBeTruthy();
  });

  it('空状态引导用户使用原生 CLI 管理', () => {
    render(
      <AssetsTab
        kind="skill"
        adapter="codex-cli"
        bundled={[]}
        user={[]}
        onView={vi.fn()}
      />,
    );

    expect(screen.getByText('未发现资产。请通过 Codex CLI 原生配置管理。')).toBeTruthy();
  });

  it('initially bounds a large catalog and reveals it in fixed pages', () => {
    const user = Array.from({ length: 120 }, (_, index) => ({
      ...userAgent(),
      name: `agent-${index}`,
      qualifiedName: `agent-${index}`,
      absPath: `/safe/agent-${index}.md`,
    }));
    render(<AssetsTab kind="agent" adapter="claude-code" bundled={[]} user={user} onView={vi.fn()} />);

    expect(screen.getAllByRole('button', { name: '查看' })).toHaveLength(50);
    fireEvent.click(screen.getByRole('button', { name: '再显示 50 项' }));
    expect(screen.getAllByRole('button', { name: '查看' })).toHaveLength(100);
    fireEvent.click(screen.getByRole('button', { name: '再显示 20 项' }));
    expect(screen.getAllByRole('button', { name: '查看' })).toHaveLength(120);
  });
});
