import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type {
  AdapterSessionMode,
  CodexPermissionScanResult,
  MergedPermissions,
  PermissionScanResult,
} from '@shared/types';
import type {
  SessionPermissionRuleDto,
  SessionPermissionsGetResult,
  SessionWorkspaceAccess,
  SessionWorkspacePermissionProjection,
} from '@contracts/index';
import { CodexPermissionsPanel } from './permissions/CodexPermissionsPanel';
import { GrokPermissionsPanel } from './permissions/GrokPermissionsPanel';
import {
  LayerPanel,
  ManagedLayerPanel,
  MergedPanel,
} from './permissions/ClaudePermissionsPanels';
import {
  PermissionField,
  PermissionRefreshField,
} from './permissions/permission-chrome';

export interface PermissionsViewProps {
  cwd: string;
  sessionId: string;
  agentId: string;
  sessionMode?: AdapterSessionMode | null;
}

type PermissionsData =
  | { adapter: 'claude'; value: PermissionScanResult }
  | { adapter: 'codex'; value: CodexPermissionScanResult };

interface PermissionsLoadState {
  key: string;
  data: PermissionsData | null;
  loading: boolean;
  error: string | null;
  initialized: boolean;
}

export interface PermissionsViewState {
  data: PermissionsData | null;
  loading: boolean;
  error: string | null;
  initialized: boolean;
  refresh(): void;
}

export interface RemotePermissionsViewState {
  data: SessionPermissionsGetResult | null;
  loading: boolean;
  error: string | null;
  refresh(): void;
}

function emptyState(key: string, isGrok: boolean): PermissionsLoadState {
  return {
    key,
    data: null,
    loading: !isGrok,
    error: null,
    initialized: isGrok,
  };
}

/** Read-only effective permission viewer for Claude settings layers and Codex config. */
export function PermissionsView({
  cwd,
  sessionId,
  agentId,
  sessionMode = null,
}: PermissionsViewProps): JSX.Element {
  const state = usePermissionsViewState({ cwd, sessionId, agentId, sessionMode });
  return (
    <PermissionsViewContent
      cwd={cwd}
      agentId={agentId}
      sessionMode={sessionMode}
      state={state}
    />
  );
}

/** Start the bounded settings scan independently from the Permissions tab presentation. */
export function usePermissionsViewState({
  cwd,
  sessionId,
  agentId,
}: PermissionsViewProps): PermissionsViewState {
  const isCodex = agentId === 'codex-cli';
  const isGrok = agentId === 'grok-build';
  const key = `${agentId}\u0000${sessionId}\u0000${cwd}`;
  const [loadState, setLoadState] = useState<PermissionsLoadState>(
    () => emptyState(key, isGrok),
  );
  const requestGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    if (isGrok) {
      setLoadState({ ...emptyState(key, true), initialized: true });
      return;
    }
    setLoadState((current) => ({
      ...(current.key === key ? current : emptyState(key, false)),
      loading: true,
      error: null,
    }));
    try {
      if (isCodex) {
        const result = await window.api.scanCodexSettings(sessionId);
        if (generation === requestGeneration.current) {
          setLoadState({
            key,
            data: { adapter: 'codex', value: result },
            loading: false,
            error: null,
            initialized: true,
          });
        }
      } else {
        const result = await window.api.scanCwdSettings(cwd);
        if (generation === requestGeneration.current) {
          setLoadState({
            key,
            data: { adapter: 'claude', value: result },
            loading: false,
            error: null,
            initialized: true,
          });
        }
      }
    } catch (error) {
      if (generation === requestGeneration.current) {
        setLoadState((current) => ({
          ...(current.key === key ? current : emptyState(key, false)),
          loading: false,
          error: error instanceof Error ? error.message : String(error),
          initialized: true,
        }));
      }
    }
  }, [cwd, isCodex, isGrok, key, sessionId]);

  useEffect(() => {
    void refresh();
    return () => {
      requestGeneration.current += 1;
    };
  }, [refresh]);

  const current = loadState.key === key ? loadState : emptyState(key, isGrok);
  return {
    data: current.data,
    loading: current.loading,
    error: current.error,
    initialized: current.initialized,
    refresh: () => void refresh(),
  };
}

export function PermissionsViewContent({
  cwd = '',
  agentId,
  sessionMode = null,
  state,
  remoteState,
  workspaceAccess,
}: Pick<PermissionsViewProps, 'agentId' | 'sessionMode'> & {
  cwd?: string;
  state?: PermissionsViewState;
  remoteState?: RemotePermissionsViewState;
  workspaceAccess?: SessionWorkspacePermissionProjection;
}): JSX.Element {
  if (remoteState) return <RemotePermissionsContent state={remoteState} />;
  if (!state) return <div className="text-[11px] text-deck-muted">暂无权限信息</div>;
  const isGrok = agentId === 'grok-build';
  if (isGrok) return (
    <div className="flex flex-col gap-3" data-session-permissions="local">
      <GrokPermissionsPanel
        sessionMode={sessionMode}
        loading={state.loading}
        onRefresh={state.refresh}
      />
      <WorkspaceAccessPanel workspace={workspaceAccess} />
      <RuleProjectionPanel rules={null} />
    </div>
  );
  if (!state.initialized || (state.loading && !state.data)) {
    return <div className="text-[11px] text-deck-muted">扫描中…</div>;
  }
  if (state.error && !state.data) {
    return (
      <div role="alert" className="flex items-center justify-between gap-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-[11px] text-red-200">
        <span>扫描失败：{state.error}</span>
        <button
          type="button"
          onClick={state.refresh}
          className="shrink-0 rounded bg-white/10 px-2 py-0.5 text-deck-text hover:bg-white/15"
        >
          重试
        </button>
      </div>
    );
  }
  if (!state.data) return <div className="text-[11px] text-deck-muted">无数据</div>;
  if (state.data.adapter === 'codex') {
    return (
      <div className="flex flex-col gap-3" data-session-permissions="local">
        {state.error && (
          <div role="status" className="text-[10px] text-status-waiting/80">
            扫描失败：{state.error}，当前显示上次结果。
          </div>
        )}
        <CodexPermissionsPanel
          data={state.data.value}
          loading={state.loading}
          onRefresh={state.refresh}
        />
        <WorkspaceAccessPanel workspace={workspaceAccess} />
        <RuleProjectionPanel rules={null} />
      </div>
    );
  }

  const scan = state.data.value;
  const projectIsUser = scan.project.path === scan.user.path;
  const localIsUserLocal = scan.local.path === scan.userLocal.path;
  return (
    <div className="flex flex-col gap-3" data-session-permissions="local">
      {state.error && (
        <div role="status" className="text-[10px] text-status-waiting/80">
          扫描失败：{state.error}，当前显示上次结果。
        </div>
      )}
      <PermissionRefreshField
        field="claude.settings-location"
        label="Claude Code 配置"
        value={scan.cwdResolved}
        loading={state.loading}
        onRefresh={state.refresh}
      />
      <MergedPanel merged={scan.merged} />
      <LayerPanel layer={scan.user} cwd={cwd} />
      <LayerPanel layer={scan.userLocal} cwd={cwd} />
      <LayerPanel layer={scan.project} cwd={cwd} notice={projectIsUser ? '会话工作目录等于主目录，与全局设置是同一文件' : undefined} />
      <LayerPanel layer={scan.local} cwd={cwd} notice={localIsUserLocal ? '会话工作目录等于主目录，与本机设置是同一文件' : undefined} />
      <WorkspaceAccessPanel workspace={workspaceAccess} />
    </div>
  );
}

const ACCESS_LABELS: Record<SessionWorkspaceAccess, string> = {
  allowed: '允许',
  denied: '禁止',
  'provider-default': '使用当前运行设置',
  unavailable: '暂时无法确认',
};

function RemotePermissionsContent({ state }: { state: RemotePermissionsViewState }): JSX.Element {
  if (state.loading && !state.data) {
    return <div className="text-[11px] text-deck-muted">正在读取权限…</div>;
  }
  if (state.error && !state.data) {
    return (
      <div role="alert" className="flex items-center justify-between gap-2 rounded border border-red-500/40 bg-red-500/10 p-2 text-[11px] text-red-200">
        <span>读取失败：{state.error}</span>
        <button type="button" onClick={state.refresh} className="shrink-0 rounded bg-white/10 px-2 py-0.5 text-deck-text hover:bg-white/15">重试</button>
      </div>
    );
  }
  if (!state.data) return <div className="text-[11px] text-deck-muted">暂无权限信息</div>;
  const data = state.data;
  const stale = state.error
    ? <div role="status" className="text-[10px] text-status-waiting/80">读取失败，当前显示上次结果。</div>
    : null;
  if (data.effective.adapterId === 'claude-code') {
    return (
      <div className="flex flex-col gap-3" data-session-permissions="remote">
        {stale}
        <PermissionRefreshField
          field="claude.settings-location"
          label="Claude Code 配置"
          value="配置文件保存在远程设备上"
          loading={state.loading}
          onRefresh={state.refresh}
        />
        <MergedPanel
          merged={remoteClaudeMerged(data)}
          sandbox={data.effective.sandbox}
          sandboxDetail={data.effective.sandboxSource === 'session'
            ? '当前会话设置'
            : 'Claude Code 当前设置'}
        />
        <ManagedLayerPanel source="user" />
        <ManagedLayerPanel source="user-local" />
        <ManagedLayerPanel source="project" />
        <ManagedLayerPanel source="local" />
        <WorkspaceAccessPanel workspace={data.workspace} />
      </div>
    );
  }
  if (data.effective.adapterId === 'codex-cli') {
    return (
      <div className="flex flex-col gap-3" data-session-permissions="remote">
        {stale}
        <CodexPermissionsPanel remote={data.effective} loading={state.loading} onRefresh={state.refresh} />
        <WorkspaceAccessPanel workspace={data.workspace} />
        <RuleProjectionPanel rules={data.rules.state === 'available' ? data.rules.items : null} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-session-permissions="remote">
      {stale}
      <GrokPermissionsPanel
        sessionMode={data.effective.sessionMode}
        remote={data.effective}
        loading={state.loading}
        onRefresh={state.refresh}
      />
      <WorkspaceAccessPanel workspace={data.workspace} />
      <RuleProjectionPanel rules={data.rules.state === 'available' ? data.rules.items : null} />
    </div>
  );
}

function remoteClaudeMerged(data: SessionPermissionsGetResult): MergedPermissions {
  if (data.effective.adapterId !== 'claude-code') throw new Error('Claude permissions expected');
  const grouped = { allow: [] as MergedPermissions['allow'], deny: [] as MergedPermissions['deny'], ask: [] as MergedPermissions['ask'] };
  if (data.rules.state === 'available') {
    for (const item of data.rules.items) {
      const target = item.effect === 'allow'
        ? grouped.allow
        : item.effect === 'deny'
          ? grouped.deny
          : grouped.ask;
      target.push({
        rule: permissionRuleLabel(item),
        sources: [item.provenance === 'core-default' ? 'user' : item.provenance === 'workspace' ? 'project' : 'local'],
      });
    }
  }
  return {
    ...grouped,
    additionalDirectories: [],
    defaultMode: {
      value: data.effective.permissionMode,
      source: data.effective.permissionModeSource === 'session' ? 'local' : 'user',
    },
    truncated: data.rules.truncated,
  };
}

function permissionRuleLabel(rule: SessionPermissionRuleDto): string {
  return rule.subject.kind === 'tool'
    ? rule.subject.tool
    : `工作区/${rule.subject.segments.join('/')}`;
}

function WorkspaceAccessPanel({
  workspace,
}: {
  workspace?: SessionWorkspacePermissionProjection;
}): JSX.Element {
  const value = workspace ?? { read: 'unavailable', write: 'unavailable', network: 'unavailable' };
  return (
    <section className="rounded-md border border-deck-border/60 bg-white/[0.03] p-2" data-permission-section="workspace">
      <header className="mb-1.5 text-[10px] uppercase tracking-wider text-deck-muted">会话访问范围</header>
      <div className="grid gap-1.5 text-[11px]">
        <PermissionField field="workspace.read" label="读取工作区" value={ACCESS_LABELS[value.read]} />
        <PermissionField field="workspace.write" label="修改文件" value={ACCESS_LABELS[value.write]} />
        <PermissionField field="workspace.network" label="使用网络" value={ACCESS_LABELS[value.network]} />
      </div>
    </section>
  );
}

function RuleProjectionPanel({ rules }: { rules: SessionPermissionRuleDto[] | null }): JSX.Element {
  return (
    <section
      className="rounded-md border border-deck-border/60 bg-white/[0.02] p-2"
      data-permission-section="rules"
      data-permission-field="session.rules"
    >
      <header className="mb-1.5 text-[10px] uppercase tracking-wider text-deck-muted">会话规则</header>
      {!rules || rules.length === 0
        ? <div className="text-[10px] text-deck-muted">当前没有单独记录的会话规则</div>
        : (
            <div className="space-y-1">
              {rules.map((rule, index) => (
                <div
                  key={`${index}-${permissionRuleLabel(rule)}`}
                  className="grid grid-cols-[92px_minmax(0,1fr)] gap-2 text-[11px]"
                >
                  <span className="text-deck-muted">
                    {rule.effect === 'allow' ? '允许' : rule.effect === 'deny' ? '禁止' : '每次询问'}
                  </span>
                  <span className="min-w-0 break-words font-mono text-deck-text/90">
                    {permissionRuleLabel(rule)}
                  </span>
                </div>
              ))}
            </div>
          )}
    </section>
  );
}
