import { useCallback, useState, type JSX } from 'react';
import log from '@renderer/utils/logger';
import type { MergedPermissions, SettingsLayer, SettingsSource } from '@shared/types';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  InfoIcon,
} from '../icons';
import {
  PermissionField,
  RawJsonBlock,
  SOURCE_LABEL,
  SourceBadge,
} from './permission-chrome';

const logger = log.scope('renderer-claude-permissions');

function safeErrorKind(reason: unknown): 'function' | 'null' | 'object' | 'primitive' | 'string' {
  if (reason === null) return 'null';
  if (typeof reason === 'object') return 'object';
  if (typeof reason === 'string') return 'string';
  if (typeof reason === 'function') return 'function';
  return 'primitive';
}

const MODE_LABELS: Record<string, string> = {
  acceptEdits: '自动接受编辑',
  auto: '自动模式',
  bypassPermissions: '绕过权限检查',
  default: '默认',
  dontAsk: '不询问',
  plan: '计划模式',
};

const SANDBOX_LABELS: Record<string, string> = {
  off: '关闭',
  'provider-default': '由 Claude Code 决定',
  strict: '严格',
  'workspace-write': '工作区可写',
};

const SETTINGS_SOURCES = new Set<SettingsSource>(['user', 'user-local', 'project', 'local']);

function mergedRules(value: unknown): MergedPermissions['allow'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const raw = candidate as { rule?: unknown; sources?: unknown };
    if (typeof raw.rule !== 'string') return [];
    const sources = Array.isArray(raw.sources)
      ? raw.sources.filter((source): source is SettingsSource => SETTINGS_SOURCES.has(source as SettingsSource))
      : [];
    return [{ rule: raw.rule, sources }];
  });
}

function mergedDirectories(value: unknown): MergedPermissions['additionalDirectories'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const raw = candidate as { dir?: unknown; sources?: unknown };
    if (typeof raw.dir !== 'string') return [];
    const sources = Array.isArray(raw.sources)
      ? raw.sources.filter((source): source is SettingsSource => SETTINGS_SOURCES.has(source as SettingsSource))
      : [];
    return [{ dir: raw.dir, sources }];
  });
}

function normalizedMerged(merged: MergedPermissions | null | undefined): MergedPermissions {
  const candidate = merged as Partial<MergedPermissions> | null | undefined;
  const defaultMode = candidate?.defaultMode;
  return {
    allow: mergedRules(candidate?.allow),
    deny: mergedRules(candidate?.deny),
    ask: mergedRules(candidate?.ask),
    additionalDirectories: mergedDirectories(candidate?.additionalDirectories),
    defaultMode: defaultMode && typeof defaultMode.value === 'string' &&
      SETTINGS_SOURCES.has(defaultMode.source)
      ? defaultMode
      : null,
    truncated: candidate?.truncated === true,
  };
}

export function MergedPanel({
  merged,
  sandbox = null,
  sandboxDetail = null,
}: {
  merged: MergedPermissions | null | undefined;
  sandbox?: string | null;
  sandboxDetail?: string | null;
}): JSX.Element {
  const value = normalizedMerged(merged);
  const mode = value.defaultMode;

  return (
    <section
      className="rounded-md border border-deck-border/60 bg-white/[0.03] p-2"
      data-permission-section="claude-effective"
    >
      <header className="mb-1.5 text-[10px] uppercase tracking-wider text-deck-muted">
        Claude Code 当前生效规则
      </header>
      <div className="grid gap-1.5 text-[11px]">
        <PermissionField
          field="claude.default-mode"
          label="默认权限模式"
          value={mode ? MODE_LABELS[mode.value] ?? mode.value : '未单独设置'}
          detail={mode
            ? <><span>{mode.value}</span>{' '}<SourceBadge source={mode.source} /></>
            : '使用 Claude Code 当前设置'}
        />
        <PermissionField
          field="claude.sandbox"
          label="系统沙盒"
          value={sandbox ? SANDBOX_LABELS[sandbox] ?? sandbox : '暂未提供'}
          detail={sandboxDetail ?? (sandbox ? undefined : '当前页面没有这项信息')}
        />
        <RuleRow field="claude.allow" label="允许" tone="allow" rules={value.allow} />
        <RuleRow field="claude.deny" label="拒绝" tone="deny" rules={value.deny} />
        <RuleRow field="claude.ask" label="每次询问" tone="ask" rules={value.ask} />
        <DirRow dirs={value.additionalDirectories} />
        {value.truncated && (
          <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-200">
            规则数量超过显示上限；每类仅显示前 500 条。
          </div>
        )}
      </div>
    </section>
  );
}

function RuleRow({
  field,
  label,
  tone,
  rules,
}: {
  field: string;
  label: string;
  tone: 'allow' | 'deny' | 'ask';
  rules: MergedPermissions['allow'];
}): JSX.Element {
  const toneClass = tone === 'allow'
    ? 'text-status-working'
    : tone === 'deny'
      ? 'text-status-waiting'
      : 'text-deck-text/80';
  return (
    <div className="text-[11px]" data-permission-field={field}>
      <div className="mb-0.5 text-[10px] text-deck-muted"><span className={toneClass}>{label}</span> ({rules.length})</div>
      {rules.length === 0 ? (
        <div className="pl-2 text-[10px] text-deck-muted/60">暂无规则</div>
      ) : (
        <ul className="flex flex-col gap-0.5 pl-2">
          {rules.map((rule) => (
            <li key={`${label}-${rule.rule}`} className="flex items-center gap-1.5">
              <span className="break-all font-mono text-deck-text/90">{rule.rule}</span>
              <span className="ml-auto flex shrink-0 gap-0.5">
                {rule.sources.map((source) => <SourceBadge key={source} source={source} />)}
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
    <div className="text-[11px]" data-permission-field="claude.additional-directories">
      <div className="mb-0.5 text-[10px] text-deck-muted">额外可访问目录（{dirs.length}）</div>
      {dirs.length === 0
        ? <div className="pl-2 text-[10px] text-deck-muted/60">暂无额外目录</div>
        : (
            <ul className="flex flex-col gap-0.5 pl-2">
              {dirs.map((dir) => (
                <li key={dir.dir} className="flex items-center gap-1.5">
                  <span className="break-all font-mono text-deck-text/90">{dir.dir}</span>
                  <span className="ml-auto flex shrink-0 gap-0.5">
                    {dir.sources.map((source) => <SourceBadge key={source} source={source} />)}
                  </span>
                </li>
              ))}
            </ul>
          )}
    </div>
  );
}

export function LayerPanel({
  layer,
  cwd,
  notice,
}: {
  layer: SettingsLayer;
  cwd: string;
  notice?: string;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const onOpen = useCallback(async () => {
    setOpenFailed(false);
    try {
      const result = await window.api.openPermissionFile(cwd, layer.path);
      if (result.ok) return;
      logger.error('permission file open failed', {
        action: 'open-permission-file',
        adapter: 'claude-code',
        source: layer.source,
        category: 'backend-rejected',
      });
      setOpenFailed(true);
    } catch (reason) {
      logger.error('permission file open failed', {
        action: 'open-permission-file',
        adapter: 'claude-code',
        source: layer.source,
        category: 'request-rejected',
        errorKind: safeErrorKind(reason),
      });
      setOpenFailed(true);
    }
  }, [cwd, layer.path, layer.source]);

  return (
    <section
      className="rounded-md border border-deck-border/60 bg-white/[0.02]"
      data-permission-field={`claude.layer.${layer.source}`}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-1.5 px-2 py-1">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-deck-muted hover:bg-white/10 hover:text-deck-text"
          title={collapsed ? '展开' : '折叠'}
          aria-label={`${collapsed ? '展开' : '折叠'}${SOURCE_LABEL[layer.source]}`}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRightIcon className="h-3 w-3" /> : <ChevronDownIcon className="h-3 w-3" />}
        </button>
        <span className="text-[11px] font-medium text-deck-text">{SOURCE_LABEL[layer.source]}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-deck-muted" title={layer.path}>{layer.path}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {layer.exists ? (
            <span className="inline-flex items-center gap-0.5 text-[10px] text-status-working"><CheckIcon className="h-3 w-3" />存在</span>
          ) : (
            <span className="text-[10px] text-deck-muted">— 未配置</span>
          )}
          <button
            type="button"
            onClick={() => void onOpen()}
            aria-label={`打开${SOURCE_LABEL[layer.source]}`}
            className="inline-flex h-7 items-center gap-1 rounded bg-white/10 px-2 text-[10px] text-deck-text hover:bg-white/15"
            title={layer.exists ? '用系统默认应用打开' : '用系统默认应用打开（文件不存在时多数编辑器会创建空文件）'}
          >
            <ExternalLinkIcon className="h-3 w-3" />打开
          </button>
        </span>
      </header>

      {notice && (
        <div className="flex items-center gap-1 border-t border-deck-border/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300/90">
          <InfoIcon className="h-3 w-3 shrink-0" />{notice}
        </div>
      )}
      {openFailed && (
        <div className="border-t border-deck-border/40 bg-red-500/10 px-2 py-1 text-[10px] text-red-300">
          无法打开设置文件，请稍后重试。
        </div>
      )}
      {!collapsed && (
        <div className="border-t border-deck-border/40 px-2 py-1.5">
          {!layer.exists ? (
            <div className="text-[10px] text-deck-muted">这层未配置；点「打开」按钮可在编辑器中创建。</div>
          ) : layer.parseError ? (
            <>
              <div className="mb-1 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10px] text-red-200">
                设置文件无法安全扫描，请检查格式、大小或规则数量。
              </div>
              <RawJsonBlock
                raw={layer.raw ?? ''}
                title={`${SOURCE_LABEL[layer.source]}原文`}
                sessionId={`claude-code-permissions:${cwd}`}
                contentId={layer.path}
              />
            </>
          ) : (
            <RawJsonBlock
              raw={layer.raw ?? ''}
              title={`${SOURCE_LABEL[layer.source]}原文`}
              sessionId={`claude-code-permissions:${cwd}`}
              contentId={layer.path}
            />
          )}
        </div>
      )}
    </section>
  );
}

/** Same settings-layer slot for a remote session, without exposing device paths or full config. */
export function ManagedLayerPanel({ source }: { source: SettingsSource }): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section
      className="rounded-md border border-deck-border/60 bg-white/[0.02]"
      data-permission-field={`claude.layer.${source}`}
    >
      <header className="flex min-w-0 flex-wrap items-center gap-1.5 px-2 py-1">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-deck-muted hover:bg-white/10 hover:text-deck-text"
          title={collapsed ? '展开' : '折叠'}
          aria-label={`${collapsed ? '展开' : '折叠'}${SOURCE_LABEL[source]}`}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRightIcon className="h-3 w-3" /> : <ChevronDownIcon className="h-3 w-3" />}
        </button>
        <span className="text-[11px] font-medium text-deck-text">{SOURCE_LABEL[source]}</span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-deck-muted">
          配置文件保存在远程设备上
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="text-[10px] text-deck-muted">只读</span>
          <button
            type="button"
            disabled
            aria-label={`打开${SOURCE_LABEL[source]}`}
            className="inline-flex h-7 items-center gap-1 rounded bg-white/10 px-2 text-[10px] text-deck-text disabled:cursor-not-allowed disabled:opacity-50"
            title="远程配置文件不能在此电脑打开"
          >
            <ExternalLinkIcon className="h-3 w-3" />打开
          </button>
        </span>
      </header>
      {!collapsed && (
        <div className="border-t border-deck-border/40 px-2 py-1.5 text-[10px] leading-relaxed text-deck-muted">
          此设备未收到配置文件位置和完整内容；上方仍会显示当前已知的生效规则。
        </div>
      )}
    </section>
  );
}
