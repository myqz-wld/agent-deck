import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type {
  AdapterSessionMode,
  CodexPermissionScanResult,
  PermissionScanResult,
} from '@shared/types';
import { RefreshIcon } from './icons';
import { CodexPermissionsPanel } from './permissions/CodexPermissionsPanel';
import { GrokPermissionsPanel } from './permissions/GrokPermissionsPanel';
import { LayerPanel, MergedPanel } from './permissions/ClaudePermissionsPanels';

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
  cwd,
  agentId,
  sessionMode = null,
  state,
}: Pick<PermissionsViewProps, 'cwd' | 'agentId' | 'sessionMode'> & {
  state: PermissionsViewState;
}): JSX.Element {
  const isGrok = agentId === 'grok-build';
  if (isGrok) return <GrokPermissionsPanel sessionMode={sessionMode} />;
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
      <div className="flex flex-col gap-2">
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
      </div>
    );
  }

  const scan = state.data.value;
  const projectIsUser = scan.project.path === scan.user.path;
  const localIsUserLocal = scan.local.path === scan.userLocal.path;
  return (
    <div className="flex flex-col gap-3">
      {state.error && (
        <div role="status" className="text-[10px] text-status-waiting/80">
          扫描失败：{state.error}，当前显示上次结果。
        </div>
      )}
      <div className="flex items-center justify-between gap-2 text-[10px] text-deck-muted">
        <div className="truncate">当前目录：<span className="font-mono text-deck-text/80">{scan.cwdResolved}</span></div>
        <button
          type="button"
          onClick={state.refresh}
          disabled={state.loading}
          className="inline-flex shrink-0 items-center gap-1 rounded bg-white/10 px-2 py-0.5 text-deck-text hover:bg-white/15 disabled:opacity-50"
        >
          {!state.loading && <RefreshIcon className="h-3 w-3" />}
          {state.loading ? '刷新中…' : '刷新'}
        </button>
      </div>
      <MergedPanel merged={scan.merged} />
      <LayerPanel layer={scan.user} cwd={cwd} />
      <LayerPanel layer={scan.userLocal} cwd={cwd} />
      <LayerPanel layer={scan.project} cwd={cwd} notice={projectIsUser ? '会话工作目录等于主目录，与全局设置是同一文件' : undefined} />
      <LayerPanel layer={scan.local} cwd={cwd} notice={localIsUserLocal ? '会话工作目录等于主目录，与本机设置是同一文件' : undefined} />
    </div>
  );
}
