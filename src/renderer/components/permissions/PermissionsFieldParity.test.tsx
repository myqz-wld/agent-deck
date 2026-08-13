// @vitest-environment happy-dom

import { cleanup, render, type RenderResult } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type {
  SessionPermissionsGetResult,
  SessionWorkspacePermissionProjection,
} from '@contracts/index';
import type {
  CodexPermissionScanResult,
  MergedPermissions,
  PermissionScanResult,
  SettingsLayer,
  SettingsSource,
} from '@shared/types';
import {
  PermissionsViewContent,
  type PermissionsViewState,
} from '../PermissionsView';
import { MergedPanel } from './ClaudePermissionsPanels';

const WORKSPACE: SessionWorkspacePermissionProjection = {
  read: 'allowed',
  write: 'allowed',
  network: 'provider-default',
};

const EXPECTED_FIELDS = {
  claude: [
    'claude.settings-location',
    'claude.default-mode',
    'claude.sandbox',
    'claude.allow',
    'claude.deny',
    'claude.ask',
    'claude.additional-directories',
    'claude.layer.user',
    'claude.layer.user-local',
    'claude.layer.project',
    'claude.layer.local',
    'workspace.read',
    'workspace.write',
    'workspace.network',
  ],
  codex: [
    'codex.settings-location',
    'codex.sandbox',
    'codex.approval',
    'codex.git-repository-check',
    'codex.default-model',
    'codex.agent-deck-connection',
    'codex.config-file',
    'workspace.read',
    'workspace.write',
    'workspace.network',
    'session.rules',
  ],
  grok: [
    'grok.settings-scope',
    'grok.session-mode',
    'grok.tool-authorization',
    'grok.sandbox',
    'grok.settings-note',
    'workspace.read',
    'workspace.write',
    'workspace.network',
    'session.rules',
  ],
} as const;

afterEach(cleanup);

function settingsLayer(source: SettingsSource): SettingsLayer {
  return {
    source,
    path: `/settings/${source}.json`,
    exists: false,
    raw: null,
    parseError: null,
    permissions: null,
  };
}

function claudeScan(): PermissionScanResult {
  return {
    cwd: '/workspace',
    cwdResolved: '/workspace',
    user: settingsLayer('user'),
    userLocal: settingsLayer('user-local'),
    project: settingsLayer('project'),
    local: settingsLayer('local'),
    merged: {
      allow: [{ rule: 'Read', sources: ['user'] }],
      deny: [],
      ask: [],
      additionalDirectories: [],
      defaultMode: { value: 'default', source: 'user' },
      truncated: false,
    },
  };
}

function codexScan(): CodexPermissionScanResult {
  return {
    adapter: 'codex-cli',
    config: {
      path: '/settings/config.toml',
      exists: false,
      raw: null,
      readError: null,
      topLevelModel: null,
    },
    effective: {
      sandboxMode: 'workspace-write',
      sandboxSource: 'session',
      approvalPolicy: 'on-request',
      approvalSource: 'agent-deck',
      skipGitRepoCheck: true,
      agentDeckMcp: {
        enabled: true,
        httpEnabled: true,
        injectedForNewSessions: true,
        toolTimeoutSec: null,
        reason: null,
      },
    },
  };
}

function localState(data: PermissionsViewState['data']): PermissionsViewState {
  return {
    data,
    loading: false,
    error: null,
    initialized: true,
    refresh: vi.fn(),
  };
}

function remoteData(
  adapter: 'claude-code' | 'codex-cli' | 'grok-build',
): SessionPermissionsGetResult {
  const effective = adapter === 'claude-code'
    ? {
        adapterId: 'claude-code' as const,
        permissionMode: 'default' as const,
        permissionModeSource: 'provider-default' as const,
        sandbox: 'provider-default' as const,
        sandboxSource: 'provider-default' as const,
      }
    : adapter === 'codex-cli'
      ? {
          adapterId: 'codex-cli' as const,
          approvalPolicy: 'provider-default' as const,
          approvalPolicySource: 'provider-default' as const,
          sandbox: 'workspace-write' as const,
          sandboxSource: 'session' as const,
        }
      : {
          adapterId: 'grok-build' as const,
          sessionMode: 'ask' as const,
          sessionModeSource: 'session' as const,
          sandbox: 'provider-default',
          sandboxSource: 'provider-default' as const,
        };
  return {
    sessionId: `remote-${adapter}`,
    adapterId: adapter,
    effective,
    workspace: WORKSPACE,
    rules: {
      state: 'available',
      items: [{
        effect: 'allow',
        subject: { kind: 'tool', tool: 'Read' },
        provenance: 'session',
      }],
      omittedCount: 0,
      truncated: false,
    },
    revision: 1,
  };
}

function permissionFields(result: RenderResult): string[] {
  return Array.from(result.container.querySelectorAll<HTMLElement>('[data-permission-field]'))
    .map((element) => element.dataset.permissionField ?? '');
}

function renderFields(element: ReactElement): string[] {
  const result = render(element);
  const fields = permissionFields(result);
  result.unmount();
  return fields;
}

describe('permission field parity', () => {
  it('keeps Claude Code local and remote fields in the same order', () => {
    const local = renderFields(
      <PermissionsViewContent
        cwd="/workspace"
        agentId="claude-code"
        state={localState({ adapter: 'claude', value: claudeScan() })}
        workspaceAccess={WORKSPACE}
      />,
    );
    const remote = renderFields(
      <PermissionsViewContent
        agentId="claude-code"
        remoteState={{ data: remoteData('claude-code'), loading: false, error: null, refresh: vi.fn() }}
      />,
    );

    expect(local).toEqual(EXPECTED_FIELDS.claude);
    expect(remote).toEqual(EXPECTED_FIELDS.claude);
  });

  it('keeps Codex local and remote fields in the same order', () => {
    const local = renderFields(
      <PermissionsViewContent
        agentId="codex-cli"
        state={localState({ adapter: 'codex', value: codexScan() })}
        workspaceAccess={WORKSPACE}
      />,
    );
    const remote = renderFields(
      <PermissionsViewContent
        agentId="codex-cli"
        remoteState={{ data: remoteData('codex-cli'), loading: false, error: null, refresh: vi.fn() }}
      />,
    );

    expect(local).toEqual(EXPECTED_FIELDS.codex);
    expect(remote).toEqual(EXPECTED_FIELDS.codex);
  });

  it('keeps Grok Build local and remote fields in the same order', () => {
    const local = renderFields(
      <PermissionsViewContent
        agentId="grok-build"
        sessionMode="ask"
        state={localState(null)}
        workspaceAccess={WORKSPACE}
      />,
    );
    const remote = renderFields(
      <PermissionsViewContent
        agentId="grok-build"
        remoteState={{ data: remoteData('grok-build'), loading: false, error: null, refresh: vi.fn() }}
      />,
    );

    expect(local).toEqual(EXPECTED_FIELDS.grok);
    expect(remote).toEqual(EXPECTED_FIELDS.grok);
  });

  it('keeps every Claude Code slot when merged arrays are missing or malformed', () => {
    const malformed = {
      allow: null,
      deny: {},
      ask: 'not-an-array',
      additionalDirectories: 1,
      defaultMode: { value: 'default', source: 'unknown' },
      truncated: false,
    } as unknown as MergedPermissions;
    const result = render(<MergedPanel merged={malformed} />);

    expect(permissionFields(result)).toEqual([
      'claude.default-mode',
      'claude.sandbox',
      'claude.allow',
      'claude.deny',
      'claude.ask',
      'claude.additional-directories',
    ]);
    expect(result.getAllByText('暂无规则')).toHaveLength(3);
    expect(result.getByText('暂无额外目录')).toBeTruthy();
  });

  it('keeps unavailable remote Codex details in their normal slots', () => {
    const result = render(
      <PermissionsViewContent
        agentId="codex-cli"
        remoteState={{ data: remoteData('codex-cli'), loading: false, error: null, refresh: vi.fn() }}
      />,
    );

    for (const field of [
      'codex.git-repository-check',
      'codex.default-model',
      'codex.agent-deck-connection',
    ]) {
      expect(result.container.querySelector(`[data-permission-field="${field}"]`)?.textContent)
        .toContain('未提供');
    }
    expect(result.container.querySelector('[data-permission-field="codex.config-file"]')?.textContent)
      .toContain('此设备未收到配置文件位置和完整内容');
  });

  it.each(['claude-code', 'codex-cli', 'grok-build'] as const)(
    'does not expose internal implementation terms for %s',
    (adapter) => {
      const result = render(
        <PermissionsViewContent
          agentId={adapter}
          remoteState={{ data: remoteData(adapter), loading: false, error: null, refresh: vi.fn() }}
        />,
      );

      expect(result.container.textContent).not.toMatch(/ACP|runtime|provider|Worker|Core|投影/iu);
    },
  );
});
