import { useCallback, useEffect, useState, type JSX } from 'react';
import type {
  CodexPermissionScanResult,
  CodexSandboxMode,
  PermissionScanResult,
} from '@shared/types';
import { RefreshIcon } from './icons';
import { CodexPermissionsPanel } from './permissions/CodexPermissionsPanel';
import { LayerPanel, MergedPanel } from './permissions/ClaudePermissionsPanels';

interface Props {
  cwd: string;
  agentId: string;
  codexSandbox?: CodexSandboxMode | null;
}

type PermissionsData =
  | { adapter: 'claude'; value: PermissionScanResult }
  | { adapter: 'codex'; value: CodexPermissionScanResult };

/** Read-only effective permission viewer for Claude settings layers and Codex config. */
export function PermissionsView({ cwd, agentId, codexSandbox }: Props): JSX.Element {
  const isCodex = agentId === 'codex-cli';
  const [data, setData] = useState<PermissionsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      if (isCodex) {
        const result = await window.api.scanCodexSettings(codexSandbox ?? null);
        setData({ adapter: 'codex', value: result });
      } else {
        const result = await window.api.scanCwdSettings(cwd);
        setData({ adapter: 'claude', value: result });
      }
    } catch (error) {
      setErr((error as Error).message ?? String(error));
    } finally {
      setLoading(false);
    }
  }, [codexSandbox, cwd, isCodex]);

  useEffect(() => {
    setData(null);
    void refresh();
  }, [refresh]);

  if (loading && !data) return <div className="text-[11px] text-deck-muted">扫描中…</div>;
  if (err) {
    return <div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-[11px] text-red-200">扫描失败：{err}</div>;
  }
  if (!data) return <div className="text-[11px] text-deck-muted">无数据</div>;
  if (data.adapter === 'codex') {
    return <CodexPermissionsPanel data={data.value} loading={loading} onRefresh={() => void refresh()} />;
  }

  const scan = data.value;
  const projectIsUser = scan.project.path === scan.user.path;
  const localIsUserLocal = scan.local.path === scan.userLocal.path;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 text-[10px] text-deck-muted">
        <div className="truncate">当前目录：<span className="font-mono text-deck-text/80">{scan.cwdResolved}</span></div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="inline-flex shrink-0 items-center gap-1 rounded bg-white/10 px-2 py-0.5 text-deck-text hover:bg-white/15 disabled:opacity-50"
        >
          {!loading && <RefreshIcon className="h-3 w-3" />}{loading ? '刷新中…' : '刷新'}
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
