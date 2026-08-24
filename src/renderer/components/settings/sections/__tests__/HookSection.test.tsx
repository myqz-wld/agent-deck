// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HookSection } from '../HookSection';

describe('HookSection', () => {
  it('offers repair when only part of the adapter hook contract is installed', () => {
    render(
      <HookSection
        title="Codex Hook"
        storageKey="test-hook-section"
        installLabel="安装 Hook"
        hookStatus={{
          state: 'partial',
          locationLabel: '/tmp/hooks.json',
          writeAllowed: true,
          disabledReason: null,
        }}
        busy={false}
        installHook={vi.fn()}
        uninstallHook={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Codex Hook' }));
    expect(screen.getByText('状态：安装不完整')).toBeTruthy();
    expect(screen.getByRole('button', { name: '修复 Hook' })).toBeTruthy();
  });

  it('keeps the installed action full width when its label changes to uninstall', () => {
    render(
      <HookSection
        title="Grok Build 终端 Hook"
        storageKey="test-installed-hook-section"
        installLabel="安装到 ~/.grok/hooks/agent-deck.json"
        hookStatus={{
          state: 'installed',
          locationLabel: '~/.grok/hooks/agent-deck.json',
          writeAllowed: true,
          disabledReason: null,
        }}
        busy={false}
        installHook={vi.fn()}
        uninstallHook={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Grok Build 终端 Hook' }));
    expect(screen.getByRole('button', { name: '卸载' }).className).toContain('w-full');
  });
});
