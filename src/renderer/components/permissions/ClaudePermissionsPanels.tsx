import { useCallback, useState, type JSX } from 'react';
import log from '@renderer/utils/logger';
import type { MergedPermissions, SettingsLayer } from '@shared/types';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  InfoIcon,
} from '../icons';
import { RawJsonBlock, SOURCE_LABEL, SourceBadge } from './permission-chrome';

const logger = log.scope('renderer-claude-permissions');

function safeErrorKind(reason: unknown): 'function' | 'null' | 'object' | 'primitive' | 'string' {
  if (reason === null) return 'null';
  if (typeof reason === 'object') return 'object';
  if (typeof reason === 'string') return 'string';
  if (typeof reason === 'function') return 'function';
  return 'primitive';
}

export function MergedPanel({ merged }: { merged: MergedPermissions }): JSX.Element {
  const empty =
    merged.allow.length === 0 &&
    merged.deny.length === 0 &&
    merged.ask.length === 0 &&
    merged.additionalDirectories.length === 0 &&
    !merged.defaultMode;

  return (
    <section className="rounded-md border border-deck-border/60 bg-white/[0.03] p-2">
      <header className="mb-1.5 flex items-center justify-between text-[10px] uppercase tracking-wider text-deck-muted">
        <span>Claude Code 当前生效规则（按全局 → 本机 → 项目 → 当前目录的顺序合并）</span>
        {merged.defaultMode && (
          <span className="text-deck-text/80">
            默认权限模式：<span className="font-mono text-status-working">{merged.defaultMode.value}</span>{' '}
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
          {merged.additionalDirectories.length > 0 && <DirRow dirs={merged.additionalDirectories} />}
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
  const toneClass = tone === 'allow'
    ? 'text-status-working'
    : tone === 'deny'
      ? 'text-status-waiting'
      : 'text-deck-text/80';
  return (
    <div className="text-[11px]">
      <div className="mb-0.5 text-[10px] text-deck-muted"><span className={toneClass}>{label}</span> ({rules.length})</div>
      {rules.length === 0 ? (
        <div className="pl-2 text-[10px] text-deck-muted/60">—</div>
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
    <div className="text-[11px]">
      <div className="mb-0.5 text-[10px] text-deck-muted">额外可访问目录（{dirs.length}）</div>
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
    <section className="rounded-md border border-deck-border/60 bg-white/[0.02]">
      <header className="flex min-w-0 flex-wrap items-center gap-1.5 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded text-deck-muted hover:bg-white/10 hover:text-deck-text"
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
            className="inline-flex h-11 items-center gap-1 rounded bg-white/10 px-2 text-[10px] text-deck-text hover:bg-white/15"
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
                JSON 解析失败，请检查该设置文件。
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
