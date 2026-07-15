// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { AssetMeta } from '@shared/types';
import { AssetCard } from './AssetCard';

afterEach(cleanup);

function asset(overrides: Partial<AssetMeta> = {}): AssetMeta {
  return {
    kind: 'agent',
    source: 'bundled',
    adapter: 'claude-code',
    name: 'reviewer-claude',
    qualifiedName: 'agent-deck:claude-code:reviewer-claude',
    description: '只读 reviewer',
    model: 'opus',
    thinking: 'xhigh',
    tools: 'Read, Grep',
    absPath: '/tmp/reviewer-claude.md',
    ...overrides,
  };
}

describe('AssetCard', () => {
  it('展示 Agent 的模型、思考程度和工具', () => {
    render(<AssetCard asset={asset()} onView={vi.fn()} />);

    expect(screen.getByText('模型：')).toBeTruthy();
    expect(screen.getByText('opus')).toBeTruthy();
    expect(screen.getByText('思考程度：')).toBeTruthy();
    expect(screen.getByText('xhigh')).toBeTruthy();
    expect(screen.getByText('工具：')).toBeTruthy();
  });

  it('不再把 Skill 描述中的 slash command 额外渲染成小字标签', () => {
    const { container } = render(
      <AssetCard
        asset={asset({
          kind: 'skill',
          name: 'hello-from-deck',
          qualifiedName: 'agent-deck:claude-code:hello-from-deck',
          description: 'Agent Deck built-in skill self-check.',
          model: undefined,
          thinking: undefined,
          tools: undefined,
        })}
        onView={vi.fn()}
      />,
    );

    const codeLabels = [...container.querySelectorAll('code')].map((node) => node.textContent);
    expect(codeLabels).toEqual(['agent-deck:claude-code:hello-from-deck']);
  });
});
