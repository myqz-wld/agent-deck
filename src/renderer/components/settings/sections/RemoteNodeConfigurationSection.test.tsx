// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { NodeConfigurationGetResult } from '@contracts/index';
import { DEFAULT_SETTINGS } from '@shared/types';

import { RemoteNodeConfigurationSection } from './RemoteNodeConfigurationSection';

function configuration(
  grokSandbox = 'workspace',
  closeAfterMs = DEFAULT_SETTINGS.closeAfterMs,
): NodeConfigurationGetResult {
  return {
    providerDefaults: {
      claudeCliPath: null,
      claudeCodeSandbox: DEFAULT_SETTINGS.claudeCodeSandbox,
      codexCliPath: null,
      codexSandbox: DEFAULT_SETTINGS.codexSandbox,
      enableAgentDeckMcp: false,
      grokCliPath: null,
      grokSandbox,
      injectAgentDeckClaudeAgents: true,
      injectAgentDeckClaudeMd: true,
      injectAgentDeckClaudeSkills: true,
      injectAgentDeckCodexAgents: true,
      injectAgentDeckCodexAgentsMd: true,
      injectAgentDeckCodexSkills: true,
      injectAgentDeckGrokAgents: true,
      injectAgentDeckGrokAgentsMd: true,
      injectAgentDeckGrokSkills: true,
      mcpHttpEnabled: false,
      permissionTimeoutMs: 30_000,
      summaryModel: '',
      summaryThinking: 'low',
      summaryTimeoutMs: 60_000,
    },
    sessionLifecycle: {
      activeWindowMs: 60_000,
      closeAfterMs,
      historyRetentionDays: 30,
    },
    revision: 1,
  };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('RemoteNodeConfigurationSection', () => {
  it('keeps short lifecycle thresholds visible without rounding them to zero hours', () => {
    render(
      <RemoteNodeConfigurationSection
        configuration={configuration('workspace', 120_000)}
        group="session"
      />,
    );

    expect((screen.getByRole('textbox', {
      name: '休眠多久后关闭',
    }) as HTMLInputElement).value).toBe('2 分钟');
  });

  it.each([
    ['read-only', '广泛只读'],
    ['workspace', '工作目录可写'],
    ['off', '⚠️ 完全开放'],
  ])('uses the shared Grok label for %s', (profile, label) => {
    render(
      <RemoteNodeConfigurationSection
        configuration={configuration(profile)}
        group="runtime"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '实验功能' }));

    expect((screen.getByRole('textbox', {
      name: 'Grok Build 沙盒（请求档位）',
    }) as HTMLInputElement).value).toBe(label);
  });

  it('shows an unknown placeholder instead of an unchecked MCP switch while loading', () => {
    render(<RemoteNodeConfigurationSection configuration={null} group="mcp" />);
    fireEvent.click(screen.getByRole('button', { name: 'Agent Deck MCP' }));

    expect(screen.queryByRole('checkbox', { name: '允许会话使用协作功能' })).toBeNull();
    expect((screen.getByRole('textbox', {
      name: '允许会话使用协作功能',
    }) as HTMLInputElement).value).toBe('—');
  });
});
