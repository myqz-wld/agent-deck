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
          installed: false,
          scope: 'user',
          settingsPath: '/tmp/hooks.json',
          installedHooks: ['SessionStart'],
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
});
