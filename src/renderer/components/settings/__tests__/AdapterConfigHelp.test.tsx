// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AdapterConfigHelp } from '../AdapterConfigHelp';

afterEach(cleanup);

describe('AdapterConfigHelp', () => {
  it.each([
    ['claude', 'Claude Code', '~/.claude/settings.json'],
    ['codex', 'Codex CLI', '~/.codex/config.toml'],
    ['grok', 'Grok Build', '~/.grok/config.toml'],
  ] as const)('uses the shared help template for %s', (adapter, name, configPath) => {
    render(<AdapterConfigHelp adapter={adapter} />);

    expect(screen.getByText('运行配置：')).toBeTruthy();
    expect(screen.getByText('终端接入：')).toBeTruthy();
    expect(screen.getByText('应用内功能：')).toBeTruthy();
    expect(screen.getByText(new RegExp(`${name} 的`))).toBeTruthy();
    expect(screen.getAllByText(configPath).length).toBeGreaterThan(0);
  });
});
