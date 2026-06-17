import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import type {
  CodexMcpServerConfigShared,
  CodexPermissionScanResult,
  CodexSandboxMode,
  MergedPermissions,
  PermissionScanResult,
  SettingsLayer,
  SettingsSource,
} from '@shared/types';

interface Props {
  cwd: string;
  agentId: string;
  codexSandbox?: CodexSandboxMode | null;
}

type PermissionsData =
  | { adapter: 'claude'; value: PermissionScanResult }
  | { adapter: 'codex'; value: CodexPermissionScanResult };

const SOURCE_LABEL: Record<SettingsSource, string> = {
  user: '全局设置',
  'user-local': '本机设置',
  project: '项目设置',
  local: '当前目录设置',
};

/** 短标记，用在「来源 chip」 */
const SOURCE_BADGE: Record<SettingsSource, string> = {
  user: '全局',
  'user-local': '本机',
  project: '项目',
  local: '目录',
};

const SOURCE_HINT: Record<SettingsSource, string> = {
  user: '~/.claude/settings.json',
  'user-local': '~/.claude/settings.local.json',
  project: '<当前目录>/.claude/settings.json',
  local: '<当前目录>/.claude/settings.local.json',
};

/**
 * 会话详情 -「权限」tab。按当前会话 cwd 解析 user / user-local / project / local 四层 settings.json，
 * 顶部展示按 SDK 优先级合并后的生效规则，下面分别展示四层完整 JSON。
 *
 * 只读：不提供编辑/删除入口；用户改配置走系统编辑器（`openPermissionFile`）。
 */
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
        const r = await window.api.scanCodexSettings(codexSandbox ?? null);
        setData({ adapter: 'codex', value: r });
      } else {
        const r = await window.api.scanCwdSettings(cwd);
        setData({ adapter: 'claude', value: r });
      }
    } catch (e) {
      setErr((e as Error).message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [codexSandbox, cwd, isCodex]);

  // cwd 变化或首次挂载时自动拉取一次
  useEffect(() => {
    setData(null);
    void refresh();
  }, [refresh]);

  if (loading && !data) {
    return <div className="text-[11px] text-deck-muted">扫描中…</div>;
  }
  if (err) {
    return (
      <div className="rounded border border-red-500/40 bg-red-500/10 p-2 text-[11px] text-red-200">
        扫描失败：{err}
      </div>
    );
  }
  if (!data) return <div className="text-[11px] text-deck-muted">无数据</div>;

  if (data.adapter === 'codex') {
    return (
      <CodexPermissionsPanel data={data.value} loading={loading} onRefresh={() => void refresh()} />
    );
  }

  const scan = data.value;

  // 在 home 目录跑会话时 project / local 路径会与 user / user-local 重合，提示用户避免误解
  const projectIsUser = scan.project.path === scan.user.path;
  const localIsUserLocal = scan.local.path === scan.userLocal.path;

  return (
    <div className="flex flex-col gap-3">
      {/* 顶部：刷新 + cwd 信息 */}
      <div className="flex items-center justify-between gap-2 text-[10px] text-deck-muted">
        <div className="truncate">
          当前目录：<span className="font-mono text-deck-text/80">{scan.cwdResolved}</span>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="shrink-0 rounded bg-white/10 px-2 py-0.5 text-deck-text hover:bg-white/15 disabled:opacity-50"
        >
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      <MergedPanel merged={scan.merged} />

      <LayerPanel layer={scan.user} cwd={cwd} />
      <LayerPanel layer={scan.userLocal} cwd={cwd} />
      <LayerPanel
        layer={scan.project}
        cwd={cwd}
        notice={projectIsUser ? '会话工作目录等于主目录，与全局设置是同一文件' : undefined}
      />
      <LayerPanel
        layer={scan.local}
        cwd={cwd}
        notice={localIsUserLocal ? '会话工作目录等于主目录，与本机设置是同一文件' : undefined}
      />
    </div>
  );
}

// ──────────────────────────────────────────── Codex Panel

const CODEX_SANDBOX_LABEL: Record<CodexSandboxMode, string> = {
  'read-only': '只读',
  'workspace-write': '工作区可写',
  'danger-full-access': '完全访问',
};

function CodexPermissionsPanel({
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
          className="shrink-0 rounded bg-white/10 px-2 py-0.5 text-deck-text hover:bg-white/15 disabled:opacity-50"
        >
          {loading ? '刷新中…' : '刷新'}
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
            detail={`${data.effective.sandboxMode} · ${
              data.effective.sandboxSource === 'session' ? '当前会话' : '全局默认'
            }`}
          />
          <CodexSummaryRow
            label="审批策略"
            value={data.effective.approvalPolicy}
            detail="Codex SDK 固定值"
          />
          <CodexSummaryRow
            label="Git 仓库检查"
            value={data.effective.skipGitRepoCheck ? '已跳过' : '启用'}
            detail="skipGitRepoCheck=true"
          />
          <CodexSummaryRow
            label="默认模型"
            value={data.config.topLevelModel ?? '未配置'}
            detail="~/.codex/config.toml 顶层 model"
          />
          <CodexSummaryRow
            label="Agent Deck MCP"
            value={data.effective.agentDeckMcp.injectedForNewSessions ? '会注入' : '未注入'}
            detail={formatAgentDeckMcpDetail(data)}
          />
        </div>
      </section>

      <McpServersPanel title="App 设置中的 Codex MCP servers" servers={data.appManagedMcpServers} />
      <McpServersPanel
        title="config.toml marker 段中的 MCP servers"
        servers={data.config.markerManagedMcpServers}
      />
      <CodexConfigPanel data={data} />
    </div>
  );
}

function CodexSummaryRow({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}): JSX.Element {
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

function McpServersPanel({
  title,
  servers,
}: {
  title: string;
  servers: CodexMcpServerConfigShared[];
}): JSX.Element {
  return (
    <section className="rounded-md border border-deck-border/60 bg-white/[0.02] p-2">
      <header className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-wider text-deck-muted">
        <span>{title}</span>
        <span>{servers.length}</span>
      </header>
      {servers.length === 0 ? (
        <div className="text-[10px] text-deck-muted">未配置</div>
      ) : (
        <ul className="flex flex-col gap-1">
          {servers.map((server) => (
            <li
              key={server.name}
              className="rounded border border-white/10 bg-black/20 px-2 py-1 text-[11px]"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-deck-text/90">{server.name}</span>
                <span className="text-[10px] text-deck-muted">
                  {server.url ? 'http' : 'stdio'}
                </span>
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
    const r = await window.api.openCodexPermissionFile(data.config.path);
    if (!r.ok) setOpenErr(r.reason ?? '打开失败');
  }, [data.config.path]);

  return (
    <section className="rounded-md border border-deck-border/60 bg-white/[0.02]">
      <header className="flex items-center gap-1.5 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="font-mono text-[10px] text-deck-muted hover:text-deck-text"
          title={collapsed ? '展开' : '折叠'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="text-[11px] font-medium text-deck-text">Codex config.toml</span>
        <span className="truncate font-mono text-[10px] text-deck-muted" title={data.config.path}>
          {data.config.path}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {data.config.exists ? (
            <span className="text-[10px] text-status-working">✓ 存在</span>
          ) : (
            <span className="text-[10px] text-deck-muted">— 未配置</span>
          )}
          <button
            type="button"
            onClick={() => void onOpen()}
            className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-deck-text hover:bg-white/15"
            title="用系统默认应用打开"
          >
            打开
          </button>
        </span>
      </header>

      {openErr && (
        <div className="border-t border-deck-border/40 bg-red-500/10 px-2 py-1 text-[10px] text-red-300">
          打开失败：{openErr}
        </div>
      )}

      {!collapsed && (
        <div className="border-t border-deck-border/40 px-2 py-1.5">
          {data.config.readError ? (
            <div className="mb-1 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10px] text-red-200">
              读取失败：{data.config.readError}
            </div>
          ) : null}
          {!data.config.exists ? (
            <div className="text-[10px] text-deck-muted">
              这层未配置；点「打开」按钮可在编辑器中创建。
            </div>
          ) : (
            <RawTextBlock raw={data.config.raw ?? ''} />
          )}
        </div>
      )}
    </section>
  );
}

// ──────────────────────────────────────────── Merged Panel

function MergedPanel({ merged }: { merged: MergedPermissions }): JSX.Element {
  const empty =
    merged.allow.length === 0 &&
    merged.deny.length === 0 &&
    merged.ask.length === 0 &&
    merged.additionalDirectories.length === 0 &&
    !merged.defaultMode;

  return (
    <section className="rounded-md border border-deck-border/60 bg-white/[0.03] p-2">
      <header className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-wider text-deck-muted">
        <span>当前生效规则（按 全局 → 本机 → 项目 → 当前目录 顺序合并）</span>
        {merged.defaultMode && (
          <span className="text-deck-text/80">
            默认权限模式：{' '}
            <span className="font-mono text-status-working">{merged.defaultMode.value}</span>{' '}
            <SourceBadge source={merged.defaultMode.source} />
          </span>
        )}
      </header>
      {empty ? (
        <div className="text-[11px] text-deck-muted">尚未配置任何权限规则</div>
      ) : (
        <div className="grid gap-1.5">
          <RuleRow label="允许" tone="allow" rules={merged.allow} />
          <RuleRow label="拒绝" tone="deny" rules={merged.deny} />
          <RuleRow label="每次询问" tone="ask" rules={merged.ask} />
          {merged.additionalDirectories.length > 0 && (
            <DirRow dirs={merged.additionalDirectories} />
          )}
        </div>
      )}
    </section>
  );
}

function RuleRow({
  label,
  tone,
  rules,
}: {
  label: string;
  tone: 'allow' | 'deny' | 'ask';
  rules: MergedPermissions['allow'];
}): JSX.Element {
  const toneClass =
    tone === 'allow'
      ? 'text-status-working'
      : tone === 'deny'
        ? 'text-status-waiting'
        : 'text-deck-text/80';
  return (
    <div className="text-[11px]">
      <div className="mb-0.5 text-[10px] text-deck-muted">
        <span className={toneClass}>{label}</span> ({rules.length})
      </div>
      {rules.length === 0 ? (
        <div className="pl-2 text-[10px] text-deck-muted/60">—</div>
      ) : (
        <ul className="flex flex-col gap-0.5 pl-2">
          {rules.map((r) => (
            <li key={`${label}-${r.rule}`} className="flex items-center gap-1.5">
              <span className="font-mono text-deck-text/90 break-all">{r.rule}</span>
              <span className="ml-auto flex shrink-0 gap-0.5">
                {r.sources.map((s) => (
                  <SourceBadge key={s} source={s} />
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DirRow({ dirs }: { dirs: MergedPermissions['additionalDirectories'] }): JSX.Element {
  return (
    <div className="text-[11px]">
      <div className="mb-0.5 text-[10px] text-deck-muted">
        额外可访问目录（{dirs.length}）
      </div>
      <ul className="flex flex-col gap-0.5 pl-2">
        {dirs.map((d) => (
          <li key={d.dir} className="flex items-center gap-1.5">
            <span className="font-mono text-deck-text/90 break-all">{d.dir}</span>
            <span className="ml-auto flex shrink-0 gap-0.5">
              {d.sources.map((s) => (
                <SourceBadge key={s} source={s} />
              ))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SourceBadge({ source }: { source: SettingsSource }): JSX.Element {
  return (
    <span
      title={SOURCE_LABEL[source] + ' · ' + SOURCE_HINT[source]}
      className="rounded border border-white/10 bg-black/30 px-1 font-mono text-[9px] text-deck-text/70"
    >
      {SOURCE_BADGE[source]}
    </span>
  );
}

// ──────────────────────────────────────────── Layer Panel

function LayerPanel({
  layer,
  cwd,
  notice,
}: {
  layer: SettingsLayer;
  cwd: string;
  notice?: string;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const [openErr, setOpenErr] = useState<string | null>(null);

  const onOpen = useCallback(async () => {
    setOpenErr(null);
    const r = await window.api.openPermissionFile(cwd, layer.path);
    if (!r.ok) setOpenErr(r.reason ?? '打开失败');
  }, [cwd, layer.path]);

  return (
    <section className="rounded-md border border-deck-border/60 bg-white/[0.02]">
      <header className="flex items-center gap-1.5 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="font-mono text-[10px] text-deck-muted hover:text-deck-text"
          title={collapsed ? '展开' : '折叠'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="text-[11px] font-medium text-deck-text">{SOURCE_LABEL[layer.source]}</span>
        <span className="truncate font-mono text-[10px] text-deck-muted" title={layer.path}>
          {layer.path}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {layer.exists ? (
            <span className="text-[10px] text-status-working">✓ 存在</span>
          ) : (
            <span className="text-[10px] text-deck-muted">— 未配置</span>
          )}
          <button
            type="button"
            onClick={() => void onOpen()}
            className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-deck-text hover:bg-white/15"
            title={
              layer.exists
                ? '用系统默认应用打开'
                : '用系统默认应用打开（文件不存在时多数编辑器会创建空文件）'
            }
          >
            打开
          </button>
        </span>
      </header>

      {notice && (
        <div className="border-t border-deck-border/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300/90">
          ⓘ {notice}
        </div>
      )}

      {openErr && (
        <div className="border-t border-deck-border/40 bg-red-500/10 px-2 py-1 text-[10px] text-red-300">
          打开失败：{openErr}
        </div>
      )}

      {!collapsed && (
        <div className="border-t border-deck-border/40 px-2 py-1.5">
          {!layer.exists ? (
            <div className="text-[10px] text-deck-muted">
              这层未配置；点「打开」按钮可在编辑器中创建。
            </div>
          ) : layer.parseError ? (
            <>
              <div className="mb-1 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10px] text-red-200">
                JSON 解析失败：{layer.parseError}
              </div>
              <RawJsonBlock raw={layer.raw ?? ''} />
            </>
          ) : (
            <RawJsonBlock raw={layer.raw ?? ''} />
          )}
        </div>
      )}
    </section>
  );
}

// ──────────────────────────────────────────── Raw JSON Block

function RawTextBlock({ raw }: { raw: string }): JSX.Element {
  return (
    <pre className="max-h-72 overflow-auto scrollbar-deck rounded bg-black/30 p-2 font-mono text-[10px] leading-snug text-deck-text/90">
      {raw}
    </pre>
  );
}

/**
 * 简易 JSON 高亮：对 key / 字符串 / number / boolean / null 着不同色。
 * 不引第三方 syntax highlighter，避免给只读 viewer 带额外 bundle。
 */
function RawJsonBlock({ raw }: { raw: string }): JSX.Element {
  const fragments = useMemo(() => highlightJson(raw), [raw]);
  return (
    <pre className="max-h-72 overflow-auto scrollbar-deck rounded bg-black/30 p-2 font-mono text-[10px] leading-snug text-deck-text/90">
      {fragments}
    </pre>
  );
}

// 简单的 JSON token 正则，覆盖：带引号的字符串（区分 key 和 value）、true/false/null、数字
// 字符串里转义的 `\"` 已经被原始 JSON.stringify 处理过，这里不再特殊处理嵌套引号
const JSON_TOKEN_RE = /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function highlightJson(raw: string): ReactNode[] {
  if (!raw) return [];
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of raw.matchAll(JSON_TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(raw.slice(last, idx));
    const [whole, key, str, kw, num] = m;
    if (key) {
      out.push(
        <span key={`k-${i++}`} className="text-sky-300">
          {key}
        </span>,
      );
    } else if (str) {
      out.push(
        <span key={`s-${i++}`} className="text-emerald-300">
          {str}
        </span>,
      );
    } else if (kw) {
      out.push(
        <span key={`b-${i++}`} className="text-amber-300">
          {kw}
        </span>,
      );
    } else if (num) {
      out.push(
        <span key={`n-${i++}`} className="text-orange-300">
          {num}
        </span>,
      );
    } else {
      out.push(whole);
    }
    last = idx + whole.length;
  }
  if (last < raw.length) out.push(raw.slice(last));
  return out;
}
