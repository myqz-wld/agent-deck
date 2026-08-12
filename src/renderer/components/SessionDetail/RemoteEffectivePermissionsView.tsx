import type {
  SessionPermissionProjection,
  SessionPermissionRuleDto,
  SessionPermissionsGetResult,
  SessionWorkspaceAccess,
} from '@contracts/index';
import { RefreshIcon } from '../icons';
import type { JSX } from 'react';

const ACCESS_LABELS: Record<SessionWorkspaceAccess, string> = {
  allowed: '允许',
  denied: '禁止',
  'provider-default': '由提供方默认值决定',
  unavailable: '无法确认',
};

const CLAUDE_MODE_LABELS: Record<string, string> = {
  default: '默认', acceptEdits: '自动接受编辑', plan: '计划模式', auto: '自动模式',
  bypassPermissions: '绕过权限检查', dontAsk: '不询问',
};
const SANDBOX_LABELS: Record<string, string> = {
  'provider-default': '由提供方默认值决定', off: '关闭', strict: '严格',
  'workspace-write': '工作区可写', 'read-only': '只读',
  'danger-full-access': '完全访问', workspace: '工作区',
};
const SOURCE_LABELS = { session: '当前会话', 'provider-default': '提供方默认值' } as const;

export function RemoteEffectivePermissionsView({
  data,
  loading,
  error,
  onRefresh,
}: {
  data: SessionPermissionsGetResult | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}): JSX.Element {
  if (loading && !data) {
    return <div className="px-2 py-3 text-[11px] text-deck-muted">正在读取 Worker 生效权限…</div>;
  }
  if (error && !data) {
    return (
      <div role="alert" className="rounded border border-red-500/40 bg-red-500/10 p-2 text-[11px] text-red-200">
        {error}
      </div>
    );
  }
  if (!data) return <div className="px-2 py-3 text-[11px] text-deck-muted">暂无权限投影。</div>;
  return (
    <div className="flex flex-col gap-3" data-remote-effective-permissions>
      <div className="flex items-center justify-between gap-2 text-[10px] text-deck-muted">
        <div>Worker 生效权限 · 只读投影</div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex shrink-0 items-center gap-1 rounded bg-white/10 px-2 py-0.5 text-deck-text hover:bg-white/15 disabled:opacity-50"
        >
          {!loading && <RefreshIcon className="h-3 w-3" />}{loading ? '刷新中…' : '刷新'}
        </button>
      </div>
      {error && <div role="status" className="text-[10px] text-status-waiting/80">{error}，当前显示上次结果。</div>}
      <EffectivePolicyCard effective={data.effective} />
      <section className="rounded-md border border-deck-border/60 bg-white/[0.03] p-2">
        <header className="mb-1.5 text-[10px] uppercase tracking-wider text-deck-muted">
          Workspace 能力
        </header>
        <div className="grid gap-1.5 text-[11px]">
          <PermissionRow label="读取" value={ACCESS_LABELS[data.workspace.read]} />
          <PermissionRow label="写入" value={ACCESS_LABELS[data.workspace.write]} />
          <PermissionRow label="网络" value={ACCESS_LABELS[data.workspace.network]} />
        </div>
      </section>
      <RuleCard rules={data.rules} />
      <div className="rounded border border-white/10 bg-black/20 p-2 text-[10px] leading-relaxed text-deck-muted">
        此页不会扫描或显示 Worker 上的 Claude、Codex、Grok 配置文件、认证文件、环境变量、密钥或绝对路径。
      </div>
    </div>
  );
}

function EffectivePolicyCard({ effective }: { effective: SessionPermissionProjection }): JSX.Element {
  let rows: Array<{ label: string; value: string; detail: string }>;
  let title: string;
  if (effective.adapterId === 'claude-code') {
    title = 'Claude Code 当前生效权限';
    rows = [
      {
        label: '权限模式',
        value: CLAUDE_MODE_LABELS[effective.permissionMode] ?? effective.permissionMode,
        detail: `${effective.permissionMode} · ${SOURCE_LABELS[effective.permissionModeSource]}`,
      },
      {
        label: '系统沙盒',
        value: SANDBOX_LABELS[effective.sandbox] ?? effective.sandbox,
        detail: SOURCE_LABELS[effective.sandboxSource],
      },
    ];
  } else if (effective.adapterId === 'codex-cli') {
    title = 'Codex CLI 当前生效权限';
    rows = [
      {
        label: '审批策略',
        value: effective.approvalPolicy === 'provider-default'
          ? '由 Codex CLI 决定' : effective.approvalPolicy,
        detail: SOURCE_LABELS[effective.approvalPolicySource],
      },
      {
        label: '沙盒模式',
        value: SANDBOX_LABELS[effective.sandbox] ?? effective.sandbox,
        detail: SOURCE_LABELS[effective.sandboxSource],
      },
    ];
  } else {
    title = 'Grok Build 当前生效权限';
    rows = [
      {
        label: '工作模式',
        value: effective.sessionMode,
        detail: SOURCE_LABELS[effective.sessionModeSource],
      },
      {
        label: '沙盒配置',
        value: SANDBOX_LABELS[effective.sandbox] ?? effective.sandbox,
        detail: SOURCE_LABELS[effective.sandboxSource],
      },
    ];
  }
  return (
    <section className="rounded-md border border-deck-border/60 bg-white/[0.03] p-2">
      <header className="mb-1.5 text-[10px] uppercase tracking-wider text-deck-muted">{title}</header>
      <div className="grid gap-1.5 text-[11px]">
        {rows.map((row) => <PermissionRow key={row.label} {...row} />)}
      </div>
    </section>
  );
}

function PermissionRow({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}): JSX.Element {
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-2">
      <span className="text-deck-muted">{label}</span>
      <span className="min-w-0 break-words">
        <span className="font-mono text-deck-text/90">{value}</span>
        {detail && <span className="ml-1 text-[10px] text-deck-muted">{detail}</span>}
      </span>
    </div>
  );
}

function RuleCard({ rules }: { rules: SessionPermissionsGetResult['rules'] }): JSX.Element {
  return (
    <section className="rounded-md border border-deck-border/60 bg-white/[0.02] p-2">
      <header className="mb-1.5 text-[10px] uppercase tracking-wider text-deck-muted">
        结构化规则
      </header>
      {rules.state === 'unavailable'
        ? <div className="text-[10px] leading-relaxed text-deck-muted">当前会话没有记录安全的结构化规则投影；不会为补齐内容读取提供方配置文件。</div>
        : <div className="space-y-1">{rules.items.map((rule, index) => <RuleRow key={index} rule={rule} />)}</div>}
      {(rules.truncated || rules.omittedCount > 0) && (
        <div className="mt-1 text-[10px] text-status-waiting/80">
          已省略 {rules.omittedCount} 条无法安全投影的规则。
        </div>
      )}
    </section>
  );
}

function RuleRow({ rule }: { rule: SessionPermissionRuleDto }): JSX.Element {
  const subject = rule.subject.kind === 'tool'
    ? `工具 · ${rule.subject.tool}`
    : `Workspace · ${rule.subject.segments.join('/')}`;
  return <PermissionRow label={rule.effect} value={subject} detail={rule.provenance} />;
}
