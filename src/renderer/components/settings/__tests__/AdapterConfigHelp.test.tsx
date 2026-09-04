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
    const { container } = render(<AdapterConfigHelp adapter={adapter} />);

    expect(screen.getByText('运行配置：')).toBeTruthy();
    expect(screen.getByText('终端接入：')).toBeTruthy();
    expect(screen.getByText('应用内功能：')).toBeTruthy();
    expect(screen.getAllByText(new RegExp(`${name} 的`)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(configPath).length).toBeGreaterThan(0);
    expect(container.textContent).toContain(`外部终端中的 ${name} 会话会通过`);
    expect(container.textContent).toContain(`Agent Deck 内的 ${name} 会话会加载`);
    expect(container.textContent).toContain('应用约定、内置 Skills、Agents 和 MCP 工具');
    expect(container.textContent).not.toContain('$CODEX_HOME');
    expect(container.textContent).not.toContain('Grok Build CLI');
  });
});
