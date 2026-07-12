import { useCallback, useState, type JSX } from 'react';
import type {
  CodexMcpServerConfigShared,
  CodexPermissionScanResult,
  CodexSandboxMode,
} from '@shared/types';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  RefreshIcon,
} from '../icons';
import { RawTextBlock } from './permission-chrome';

const CODEX_SANDBOX_LABEL: Record<CodexSandboxMode, string> = {
  'read-only': '只读',
  'workspace-write': '工作区可写',
  'danger-full-access': '完全访问',
};

export function CodexPermissionsPanel({
  data,
  loading,
  onRefresh,
}: {
  data: CodexPermissionScanResult;
  loading: boolean;
  onRefresh: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 text-[10px] text-deck-muted">
        <div className="truncate">
          Codex 配置：<span className="font-mono text-deck-text/80">{data.config.path}</span>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex shrink-0 items-center gap-1 rounded bg-white/10 px-2 py-0.5 text-deck-text hover:bg-white/15 disabled:opacity-50"
        >
          {!loading && <RefreshIcon className="h-3 w-3" />}{loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      <section className="rounded-md border border-deck-border/60 bg-white/[0.03] p-2">
        <header className="mb-1.5 text-[10px] uppercase tracking-wider text-deck-muted">
          Codex 当前生效配置
        </header>
        <div className="grid gap-1.5 text-[11px]">
          <CodexSummaryRow
            label="沙盒模式"
            value={CODEX_SANDBOX_LABEL[data.effective.sandboxMode]}
            detail={`${data.effective.sandboxMode} · ${data.effective.sandboxSource === 'session' ? '当前会话' : '全局默认'}`}
          />
          <CodexSummaryRow label="审批策略" value={data.effective.approvalPolicy} detail="Codex SDK 固定值" />
          <CodexSummaryRow
            label="Git 仓库检查"
            value={data.effective.skipGitRepoCheck ? '已跳过' : '启用'}
            detail="skipGitRepoCheck=true"
          />
          <CodexSummaryRow label="默认模型" value={data.config.topLevelModel ?? '未配置'} detail="~/.codex/config.toml 顶层 model" />
          <CodexSummaryRow
            label="Agent Deck MCP"
            value={data.effective.agentDeckMcp.injectedForNewSessions ? '会注入' : '未注入'}
            detail={formatAgentDeckMcpDetail(data)}
          />
        </div>
      </section>

      <McpServersPanel title="App 设置中的 Codex MCP servers" servers={data.appManagedMcpServers} />
      <McpServersPanel title="config.toml marker 段中的 MCP servers" servers={data.config.markerManagedMcpServers} />
      <CodexConfigPanel data={data} />
    </div>
  );
}

function CodexSummaryRow({ label, value, detail }: { label: string; value: string; detail: string }): JSX.Element {
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2">
      <span className="text-deck-muted">{label}</span>
      <span className="min-w-0">
        <span className="font-mono text-deck-text/90">{value}</span>
        <span className="ml-1 text-[10px] text-deck-muted">{detail}</span>
      </span>
    </div>
  );
}

function formatAgentDeckMcpDetail(data: CodexPermissionScanResult): string {
  const mcp = data.effective.agentDeckMcp;
  if (!mcp.injectedForNewSessions) return mcp.reason ?? '未满足注入条件';
  if (mcp.toolTimeoutSec === null) return '下次新建 Codex 会话生效';
  if (mcp.toolTimeoutSec === 0) return '下次新建 Codex 会话生效 · tool timeout 不限制';
  return `下次新建 Codex 会话生效 · tool timeout ${mcp.toolTimeoutSec}s`;
}

function McpServersPanel({ title, servers }: { title: string; servers: CodexMcpServerConfigShared[] }): JSX.Element {
  return (
    <section className="rounded-md border border-deck-border/60 bg-white/[0.02] p-2">
      <header className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-wider text-deck-muted">
        <span>{title}</span><span>{servers.length}</span>
      </header>
      {servers.length === 0 ? (
        <div className="text-[10px] text-deck-muted">未配置</div>
      ) : (
        <ul className="flex flex-col gap-1">
          {servers.map((server) => (
            <li key={server.name} className="rounded border border-white/10 bg-black/20 px-2 py-1 text-[11px]">
              <div className="flex items-center gap-2">
                <span className="font-mono text-deck-text/90">{server.name}</span>
                <span className="text-[10px] text-deck-muted">{server.url ? 'http' : 'stdio'}</span>
              </div>
              <div className="mt-0.5 break-all font-mono text-[10px] text-deck-muted">
                {server.url ?? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CodexConfigPanel({ data }: { data: CodexPermissionScanResult }): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const [openErr, setOpenErr] = useState<string | null>(null);
  const onOpen = useCallback(async () => {
    setOpenErr(null);
    const result = await window.api.openCodexPermissionFile(data.config.path);
    if (!result.ok) setOpenErr(result.reason ?? '打开失败');
  }, [data.config.path]);

  return (
    <section className="rounded-md border border-deck-border/60 bg-white/[0.02]">
      <header className="flex items-center gap-1.5 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="text-deck-muted hover:text-deck-text"
          title={collapsed ? '展开' : '折叠'}
          aria-label={collapsed ? '展开 Codex config.toml' : '折叠 Codex config.toml'}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRightIcon className="h-3 w-3" /> : <ChevronDownIcon className="h-3 w-3" />}
        </button>
        <span className="text-[11px] font-medium text-deck-text">Codex config.toml</span>
        <span className="truncate font-mono text-[10px] text-deck-muted" title={data.config.path}>{data.config.path}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {data.config.exists ? (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-status-working"><CheckIcon className="h-3 w-3" />存在</span>
          ) : (
            <span className="text-[10px] text-deck-muted">— 未配置</span>
          )}
          <button
            type="button"
            onClick={() => void onOpen()}
            className="inline-flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-deck-text hover:bg-white/15"
            title="用系统默认应用打开"
          >
            <ExternalLinkIcon className="h-3 w-3" />打开
          </button>
        </span>
      </header>
      {openErr && <div className="border-t border-deck-border/40 bg-red-500/10 px-2 py-1 text-[10px] text-red-300">打开失败：{openErr}</div>}
      {!collapsed && (
        <div className="border-t border-deck-border/40 px-2 py-1.5">
          {data.config.readError && (
            <div className="mb-1 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10px] text-red-200">读取失败：{data.config.readError}</div>
          )}
          {!data.config.exists
            ? <div className="text-[10px] text-deck-muted">这层未配置；点「打开」按钮可在编辑器中创建。</div>
            : <RawTextBlock raw={data.config.raw ?? ''} />}
        </div>
      )}
    </section>
  );
}
