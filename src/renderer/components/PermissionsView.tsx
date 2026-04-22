import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import type {
  MergedPermissions,
  PermissionScanResult,
  SettingsLayer,
  SettingsSource,
} from '@shared/types';

interface Props {
  cwd: string;
}

const SOURCE_LABEL: Record<SettingsSource, string> = {
  user: 'User',
  'user-local': 'User Local',
  project: 'Project',
  local: 'Local',
};

/** 短标记，用在「来源 chip」 */
const SOURCE_BADGE: Record<SettingsSource, string> = {
  user: 'U',
  'user-local': 'UL',
  project: 'P',
  local: 'L',
};

const SOURCE_HINT: Record<SettingsSource, string> = {
  user: '~/.claude/settings.json',
  'user-local': '~/.claude/settings.local.json',
  project: '<cwd>/.claude/settings.json',
  local: '<cwd>/.claude/settings.local.json',
};

/**
 * 会话详情 -「权限」tab。按当前会话 cwd 解析 user / user-local / project / local 四层 settings.json，
 * 顶部展示按 SDK 优先级合并后的生效规则，下面分别展示四层完整 JSON。
 *
 * 只读：不提供编辑/删除入口；用户改配置走系统编辑器（`openPermissionFile`）。
 */
export function PermissionsView({ cwd }: Props): JSX.Element {
  const [data, setData] = useState<PermissionScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await window.api.scanCwdSettings(cwd);
      setData(r);
    } catch (e) {
      setErr((e as Error).message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  // cwd 变化或首次挂载时自动拉取一次
  useEffect(() => {
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

  // 在 home 目录跑会话时 project / local 路径会与 user / user-local 重合，提示用户避免误解
  const projectIsUser = data.project.path === data.user.path;
  const localIsUserLocal = data.local.path === data.userLocal.path;

  return (
    <div className="flex flex-col gap-3">
      {/* 顶部：刷新 + cwd 信息 */}
      <div className="flex items-center justify-between gap-2 text-[10px] text-deck-muted">
        <div className="truncate">
          cwd：<span className="font-mono text-deck-text/80">{data.cwdResolved}</span>
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

      <MergedPanel merged={data.merged} />

      <LayerPanel layer={data.user} cwd={cwd} />
      <LayerPanel layer={data.userLocal} cwd={cwd} />
      <LayerPanel
        layer={data.project}
        cwd={cwd}
        notice={projectIsUser ? '会话 cwd 等于 home 目录，与 User 是同一文件' : undefined}
      />
      <LayerPanel
        layer={data.local}
        cwd={cwd}
        notice={localIsUserLocal ? '会话 cwd 等于 home 目录，与 User Local 是同一文件' : undefined}
      />
    </div>
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
        <span>生效合并 · user → user-local → project → local</span>
        {merged.defaultMode && (
          <span className="text-deck-text/80">
            defaultMode:{' '}
            <span className="font-mono text-status-working">{merged.defaultMode.value}</span>{' '}
            <SourceBadge source={merged.defaultMode.source} />
          </span>
        )}
      </header>
      {empty ? (
        <div className="text-[11px] text-deck-muted">三层均未配置任何 permissions</div>
      ) : (
        <div className="grid gap-1.5">
          <RuleRow label="allow" tone="allow" rules={merged.allow} />
          <RuleRow label="deny" tone="deny" rules={merged.deny} />
          <RuleRow label="ask" tone="ask" rules={merged.ask} />
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
        additionalDirectories ({dirs.length})
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
