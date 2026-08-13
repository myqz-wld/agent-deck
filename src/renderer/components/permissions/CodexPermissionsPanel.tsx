import { useCallback, useState, type JSX } from 'react';
import log from '@renderer/utils/logger';
import type {
  CodexPermissionScanResult,
  CodexSandboxMode,
} from '@shared/types';
import type { CodexSessionPermissionProjection } from '@contracts/index';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
} from '../icons';
import {
  PermissionField,
  PermissionRefreshField,
  RawTextBlock,
} from './permission-chrome';

const logger = log.scope('renderer-codex-permissions');

const CODEX_SANDBOX_LABEL: Record<CodexSandboxMode, string> = {
  'read-only': '只读',
  'workspace-write': '工作区可写',
  'danger-full-access': '完全访问',
};

function safeErrorKind(reason: unknown): 'function' | 'null' | 'object' | 'primitive' | 'string' {
  if (reason === null) return 'null';
  if (typeof reason === 'object') return 'object';
  if (typeof reason === 'string') return 'string';
  if (typeof reason === 'function') return 'function';
  return 'primitive';
}

export function CodexPermissionsPanel({
  data,
  loading,
  onRefresh,
  remote,
}: {
  data?: CodexPermissionScanResult;
  loading: boolean;
  onRefresh: () => void;
  remote?: CodexSessionPermissionProjection;
}): JSX.Element {
  if (!data && !remote) throw new Error('Codex permission presentation is unavailable');
  const configLabel = data?.config.path ?? '配置文件保存在远程设备上';
  const sandbox = data?.effective.sandboxMode ?? remote!.sandbox;
  const approval = data
    ? data.effective.approvalPolicy ?? '由 Codex 决定'
    : remote!.approvalPolicy === 'provider-default'
      ? '由 Codex 决定'
      : remote!.approvalPolicy;
  return (
    <div className="flex flex-col gap-3">
      <PermissionRefreshField
        field="codex.settings-location"
        label="Codex 配置"
        value={configLabel}
        loading={loading}
        onRefresh={onRefresh}
      />

      <section className="rounded-md border border-deck-border/60 bg-white/[0.03] p-2">
        <header className="mb-1.5 text-[10px] uppercase tracking-wider text-deck-muted">
          Codex 当前生效配置
        </header>
        <div className="grid gap-1.5 text-[11px]">
          <CodexSummaryRow
            field="codex.sandbox"
            label="沙盒模式"
            value={sandbox === 'provider-default' ? '由 Codex 决定' : CODEX_SANDBOX_LABEL[sandbox]}
            detail={data
              ? `${sandbox} · ${data.effective.sandboxSource === 'session' ? '当前会话' : '全局默认'}`
              : remote!.sandboxSource === 'session' ? '当前会话' : 'Codex 默认值'}
          />
          <CodexSummaryRow
            field="codex.approval"
            label="审批策略"
            value={approval}
            detail={data
              ? data.effective.approvalSource === 'codex-config'
                ? '使用 Codex config.toml 中的设置'
                : '使用当前会话设置'
              : remote!.approvalPolicySource === 'session' ? '当前会话' : 'Codex 默认值'}
          />
          <CodexSummaryRow
            field="codex.git-repository-check"
            label="Git 仓库检查"
            value={data ? data.effective.skipGitRepoCheck ? '已跳过' : '启用' : '未提供'}
            detail={data ? '创建会话时的实际设置' : '当前没有这项信息'}
          />
          <CodexSummaryRow
            field="codex.default-model"
            label="默认模型"
            value={data?.config.topLevelModel ?? (data ? '未配置' : '未提供')}
            detail={data ? 'Codex 配置中的默认模型' : '当前没有这项信息'}
          />
          <CodexSummaryRow
            field="codex.agent-deck-connection"
            label="Agent Deck 连接"
            value={data
              ? data.effective.agentDeckMcp.injectedForNewSessions ? '会注入' : '未注入'
              : '未提供'}
            detail={data ? formatAgentDeckMcpDetail(data) : '请在远程设置页查看'}
          />
        </div>
      </section>

      <CodexConfigPanel data={data ?? null} />
    </div>
  );
}

function CodexSummaryRow({
  field,
  label,
  value,
  detail,
}: {
  field: string;
  label: string;
  value: string;
  detail: string;
}): JSX.Element {
  return <PermissionField field={field} label={label} value={value} detail={detail} />;
}

function formatAgentDeckMcpDetail(data: CodexPermissionScanResult): string {
  const mcp = data.effective.agentDeckMcp;
  if (!mcp.injectedForNewSessions) {
    if (!mcp.enabled) return 'Agent Deck 连接已关闭';
    if (!mcp.httpEnabled) return 'Agent Deck 的远程连接已关闭，Codex 无法连接';
    return '未满足注入条件';
  }
  if (mcp.toolTimeoutSec === null) return '下次新建 Codex 会话时生效';
  if (mcp.toolTimeoutSec === 0) return '下次新建 Codex 会话时生效 · 等待时间不限';
  return `下次新建 Codex 会话时生效 · 最长等待 ${mcp.toolTimeoutSec} 秒`;
}

function CodexConfigPanel({ data }: { data: CodexPermissionScanResult | null }): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const onOpen = useCallback(async () => {
    setOpenFailed(false);
    try {
      if (!data) return;
      const result = await window.api.openCodexPermissionFile(data.config.path);
      if (result.ok) return;
      logger.error('permission file open failed', {
        action: 'open-permission-file',
        adapter: 'codex-cli',
        source: 'config',
        category: 'backend-rejected',
      });
      setOpenFailed(true);
    } catch (reason) {
      logger.error('permission file open failed', {
        action: 'open-permission-file',
        adapter: 'codex-cli',
        source: 'config',
        category: 'request-rejected',
        errorKind: safeErrorKind(reason),
      });
      setOpenFailed(true);
    }
  }, [data]);

  return (
    <section
      className="rounded-md border border-deck-border/60 bg-white/[0.02]"
      data-permission-field="codex.config-file"
    >
      <header className="flex min-w-0 flex-wrap items-center gap-1.5 px-2 py-1">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-deck-muted hover:bg-white/10 hover:text-deck-text"
          title={collapsed ? '展开' : '折叠'}
          aria-label={collapsed ? '展开 Codex CLI config.toml' : '折叠 Codex CLI config.toml'}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRightIcon className="h-3 w-3" /> : <ChevronDownIcon className="h-3 w-3" />}
        </button>
        <span className="text-[11px] font-medium text-deck-text">Codex config.toml</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-deck-muted" title={data?.config.path}>{data?.config.path ?? '配置文件保存在远程设备上'}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {data?.config.exists ? (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-status-working"><CheckIcon className="h-3 w-3" />存在</span>
          ) : data ? (
            <span className="text-[10px] text-deck-muted">— 未配置</span>
          ) : <span className="text-[10px] text-deck-muted">只读</span>}
          <button
            type="button"
            onClick={() => void onOpen()}
            disabled={!data}
            aria-label="打开 Codex CLI config.toml"
            className="inline-flex h-7 items-center gap-1 rounded bg-white/10 px-2 text-[10px] text-deck-text hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
            title={data ? '用系统默认应用打开' : '远程文件不能在此电脑打开'}
          >
            <ExternalLinkIcon className="h-3 w-3" />打开
          </button>
        </span>
      </header>
      {openFailed && (
        <div className="border-t border-deck-border/40 bg-red-500/10 px-2 py-1 text-[10px] text-red-300">
          无法打开设置文件，请稍后重试。
        </div>
      )}
      {!collapsed && (
        <div className="border-t border-deck-border/40 px-2 py-1.5">
          {data?.config.readError && (
            <div className="mb-1 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10px] text-red-200">
              配置读取失败，请刷新后重试。
            </div>
          )}
          {!data
            ? <div className="text-[10px] text-deck-muted">此设备未收到配置文件位置和完整内容。</div>
            : !data.config.exists
              ? <div className="text-[10px] text-deck-muted">这层未配置；点「打开」按钮可在编辑器中创建。</div>
            : (
              <RawTextBlock
                raw={data.config.raw ?? ''}
                title="Codex CLI config.toml 原文"
                sessionId="codex-cli-permissions"
                contentId={data.config.path}
              />
            )}
        </div>
      )}
    </section>
  );
}
