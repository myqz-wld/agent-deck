// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { CodexPermissionScanResult, SettingsLayer } from '@shared/types';

const loggerSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('@renderer/utils/logger', () => ({
  default: { scope: () => loggerSpies },
}));

import {
  createAuthorizedContentReferenceId,
  type DiffContentPayload,
} from '../expandable-content';
import { LayerPanel, MergedPanel } from './ClaudePermissionsPanels';
import { CodexPermissionsPanel } from './CodexPermissionsPanel';
import { GrokPermissionsPanel } from './GrokPermissionsPanel';
import { ExpandablePermissionSurface } from './b18/ExpandablePermissionSurface';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
  loggerSpies.error.mockReset();
});

describe('B18 permission viewers', () => {
  it('labels a bounded merged permission result as truncated', () => {
    render(<MergedPanel merged={{
      allow: [{ rule: 'Bash(*)', sources: ['user'] }],
      deny: [],
      ask: [],
      additionalDirectories: [],
      defaultMode: null,
      truncated: true,
    }} />);
    expect(screen.getByText('规则数量超过显示上限；每类仅显示前 500 条。')).toBeTruthy();
  });

  it('expands raw config without replacing the separate external open action', async () => {
    const raw = '{\n  "permissions": {\n    "allow": ["Read"]\n  }\n}\n';
    const layer: SettingsLayer = {
      source: 'user',
      path: '/Users/example/.claude/settings.json',
      exists: true,
      raw,
      parseError: null,
      permissions: null,
    };
    const openPermissionFile = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { openPermissionFile },
    });

    render(<LayerPanel layer={layer} cwd="/workspace/project" />);
    fireEvent.click(screen.getByRole('button', { name: '打开全局设置' }));
    await waitFor(() => {
      expect(openPermissionFile).toHaveBeenCalledWith('/workspace/project', layer.path);
    });

    const trigger = screen.getByRole('button', {
      name: '展开查看全局设置原文',
    });
    expect(trigger.className).toContain('h-11');
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: '全局设置原文' });
    expect(dialog.querySelector('pre')?.textContent).toBe(raw);
  });

  it('mounts a typed image diff only after expansion and preserves its reference', () => {
    const reference = {
      kind: 'diff' as const,
      referenceId: createAuthorizedContentReferenceId('permission-diff-1'),
      authorization: {
        sessionId: 'session-1',
        grantId: 'permission-grant-1',
        capability: 'read-diff' as const,
      },
      presentation: 'image-diff' as const,
    };
    const payload: DiffContentPayload = { kind: 'diff', reference };
    const renderDiff = vi.fn(() => <div data-testid="typed-permission-diff">图片差异</div>);
    const observed: DiffContentPayload[] = [];

    render(
      <ExpandablePermissionSurface
        identity={{
          sessionId: 'session-1',
          kind: 'request',
          requestId: 'permission-1',
        }}
        payload={payload}
        title="权限差异"
        triggerLabel="展开权限差异"
        compact={<div>差异摘要</div>}
        expanded={({ payload: received }) => {
          observed.push(received);
          return null;
        }}
        heavyView={{
          id: 'permission-diff-heavy',
          kind: 'image-diff',
          render: renderDiff,
        }}
      />,
    );

    expect(renderDiff).not.toHaveBeenCalled();
    expect(screen.queryByTestId('typed-permission-diff')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开权限差异' }));
    expect(screen.getByTestId('typed-permission-diff')).toBeTruthy();
    expect(renderDiff).toHaveBeenCalledOnce();
    expect(observed.at(-1)).toBe(payload);
    expect(observed.at(-1)?.reference).toBe(reference);
  });

  it('expands the Codex CLI TOML verbatim without coupling it to Open', async () => {
    const raw = 'model = "gpt-5.6-sol"\napproval_policy = "on-request"\n';
    const data: CodexPermissionScanResult = {
      adapter: 'codex-cli',
      config: {
        path: '/Users/example/.codex/config.toml',
        exists: true,
        raw,
        readError: null,
        topLevelModel: 'gpt-5.6-sol',
        markerManagedMcpServers: [],
      },
      appManagedMcpServers: [],
      effective: {
        sandboxMode: 'read-only',
        sandboxSource: 'settings',
        approvalPolicy: null,
        approvalSource: 'codex-config',
        skipGitRepoCheck: true,
        agentDeckMcp: {
          enabled: false,
          httpEnabled: false,
          injectedForNewSessions: false,
          toolTimeoutSec: null,
          reason: 'disabled',
        },
      },
    };
    const openCodexPermissionFile = vi.fn().mockResolvedValue({ ok: true });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { openCodexPermissionFile },
    });

    render(
      <CodexPermissionsPanel
        data={data}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', {
      name: '打开 Codex CLI config.toml',
    }));
    await waitFor(() => {
      expect(openCodexPermissionFile).toHaveBeenCalledWith(data.config.path);
    });

    fireEvent.click(screen.getByRole('button', {
      name: '展开查看 Codex CLI config.toml 原文',
    }));
    const dialog = screen.getByRole('dialog', {
      name: 'Codex CLI config.toml 原文',
    });
    expect(dialog.querySelector('pre')?.textContent).toBe(raw);
  });

  it('uses canonical adapter names while keeping protocol identifiers intact', () => {
    render(<GrokPermissionsPanel sessionMode="ask" />);
    expect(screen.getByText('Grok Build 当前运行权限')).toBeTruthy();
    expect(screen.getByText(/Grok Build 会话不读取 Claude Code settings\.json/)).toBeTruthy();
    expect(screen.getByText(/Codex CLI sandbox\/approval policy/)).toBeTruthy();
    expect(screen.getByText(/ask · ACP session mode/)).toBeTruthy();
  });

  it('redacts Claude Code parse and open errors from UI and logs', async () => {
    const parseMarker = 'PARSE_SECRET raw-marker /private/parse-path';
    const backendMarker = 'OPEN_REASON_SECRET raw-marker /private/open-path';
    const thrownMarker = 'OPEN_THROWN_SECRET raw-marker /private/thrown-path';
    const rawMarker = 'RAW_CONFIG_CONTENT_MARKER';
    const layer: SettingsLayer = {
      source: 'project',
      path: '/workspace/project/.claude/settings.json',
      exists: true,
      raw: `{"note":"${rawMarker}"}`,
      parseError: parseMarker,
      permissions: null,
    };
    const openPermissionFile = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: backendMarker })
      .mockRejectedValueOnce(new Error(thrownMarker));
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { openPermissionFile },
    });

    render(<LayerPanel layer={layer} cwd="/workspace/project" />);

    expect(screen.getByText('设置文件无法安全扫描，请检查格式、大小或规则数量。')).toBeTruthy();
    expect(document.body.textContent).not.toContain(parseMarker);
    const open = screen.getByRole('button', { name: '打开项目设置' });
    fireEvent.click(open);
    expect(await screen.findByText('无法打开设置文件，请稍后重试。')).toBeTruthy();
    expect(document.body.textContent).not.toContain(backendMarker);

    fireEvent.click(open);
    await waitFor(() => expect(openPermissionFile).toHaveBeenCalledTimes(2));
    expect(screen.getByText('无法打开设置文件，请稍后重试。')).toBeTruthy();
    expect(document.body.textContent).not.toContain(thrownMarker);

    expect(loggerSpies.error).toHaveBeenCalledTimes(2);
    expect(loggerSpies.error.mock.calls.map(([, fields]) => fields)).toEqual([
      {
        action: 'open-permission-file',
        adapter: 'claude-code',
        source: 'project',
        category: 'backend-rejected',
      },
      {
        action: 'open-permission-file',
        adapter: 'claude-code',
        source: 'project',
        category: 'request-rejected',
        errorKind: 'object',
      },
    ]);
    const logs = JSON.stringify(loggerSpies.error.mock.calls);
    for (const sensitive of [
      parseMarker,
      backendMarker,
      thrownMarker,
      rawMarker,
      layer.path,
    ]) {
      expect(logs).not.toContain(sensitive);
    }
  });

  it('redacts Codex CLI read and open errors from UI and logs', async () => {
    const readMarker = 'READ_SECRET raw-marker /private/read-path';
    const backendMarker = 'CODEX_OPEN_SECRET raw-marker /private/open-path';
    const thrownMarker = 'CODEX_THROWN_SECRET raw-marker /private/thrown-path';
    const rawMarker = 'CODEX_RAW_CONFIG_CONTENT_MARKER';
    const data: CodexPermissionScanResult = {
      adapter: 'codex-cli',
      config: {
        path: '/Users/example/.codex/config.toml',
        exists: true,
        raw: `note = "${rawMarker}"\n`,
        readError: readMarker,
        topLevelModel: null,
        markerManagedMcpServers: [],
      },
      appManagedMcpServers: [],
      effective: {
        sandboxMode: 'read-only',
        sandboxSource: 'settings',
        approvalPolicy: null,
        approvalSource: 'codex-config',
        skipGitRepoCheck: true,
        agentDeckMcp: {
          enabled: false,
          httpEnabled: false,
          injectedForNewSessions: false,
          toolTimeoutSec: null,
          reason: 'Agent Deck MCP 已关闭',
        },
      },
    };
    const openCodexPermissionFile = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: backendMarker })
      .mockRejectedValueOnce(new Error(thrownMarker));
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { openCodexPermissionFile },
    });

    render(
      <CodexPermissionsPanel
        data={data}
        loading={false}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByText('配置读取失败，请刷新后重试。')).toBeTruthy();
    expect(document.body.textContent).not.toContain(readMarker);
    const open = screen.getByRole('button', {
      name: '打开 Codex CLI config.toml',
    });
    fireEvent.click(open);
    expect(await screen.findByText('无法打开设置文件，请稍后重试。')).toBeTruthy();
    expect(document.body.textContent).not.toContain(backendMarker);

    fireEvent.click(open);
    await waitFor(() => expect(openCodexPermissionFile).toHaveBeenCalledTimes(2));
    expect(screen.getByText('无法打开设置文件，请稍后重试。')).toBeTruthy();
    expect(document.body.textContent).not.toContain(thrownMarker);

    expect(loggerSpies.error).toHaveBeenCalledTimes(2);
    expect(loggerSpies.error.mock.calls.map(([, fields]) => fields)).toEqual([
      {
        action: 'open-permission-file',
        adapter: 'codex-cli',
        source: 'config',
        category: 'backend-rejected',
      },
      {
        action: 'open-permission-file',
        adapter: 'codex-cli',
        source: 'config',
        category: 'request-rejected',
        errorKind: 'object',
      },
    ]);
    const logs = JSON.stringify(loggerSpies.error.mock.calls);
    for (const sensitive of [
      readMarker,
      backendMarker,
      thrownMarker,
      rawMarker,
      data.config.path,
    ]) {
      expect(logs).not.toContain(sensitive);
    }
  });
});
