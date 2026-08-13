import type { AdapterSessionMode } from '@shared/types';
import type { GrokSessionPermissionProjection } from '@contracts/index';
import type { JSX } from 'react';
import { PermissionField, PermissionRefreshField } from './permission-chrome';

const MODE_LABELS: Record<AdapterSessionMode, string> = {
  default: '默认（可执行）',
  plan: '计划模式',
  ask: '问答模式',
};

export function GrokPermissionsPanel({
  sessionMode,
  remote,
  loading = false,
  onRefresh,
}: {
  sessionMode: AdapterSessionMode | null;
  remote?: GrokSessionPermissionProjection;
  loading?: boolean;
  onRefresh?: () => void;
}): JSX.Element {
  const effectiveMode = remote?.sessionMode ?? sessionMode ?? 'default';
  const sandbox = remote?.sandbox;
  const sandboxLabel = sandbox === 'provider-default'
    ? '由 Grok Build 决定'
    : sandbox === 'read-only'
      ? '只读'
      : sandbox === 'workspace'
        ? '工作区可写'
        : sandbox ?? '由 Grok Build 决定';
  return (
    <div className="flex flex-col gap-3">
      <PermissionRefreshField
        field="grok.settings-scope"
        label="权限范围"
        value="当前会话"
        loading={loading}
        onRefresh={onRefresh}
      />
      <section className="rounded-md border border-deck-border/60 bg-white/[0.03] p-2">
        <header className="mb-1.5 text-[10px] uppercase tracking-wider text-deck-muted">
          Grok Build 当前运行权限
        </header>
        <div className="grid gap-2 text-[11px]">
          <PermissionField
            field="grok.session-mode"
            label="工作模式"
            value={MODE_LABELS[effectiveMode]}
            detail={remote?.sessionModeSource === 'session' ? '当前会话设置' : 'Grok Build 当前设置'}
          />
          <PermissionField
            field="grok.tool-authorization"
            label="工具授权"
            value="需要时会向你确认"
            detail="由 Grok Build 发起确认"
          />
          <PermissionField
            field="grok.sandbox"
            label="文件和网络"
            value={sandboxLabel}
            detail={remote?.sandboxSource === 'session' ? '当前会话设置' : 'Grok Build 当前设置'}
          />
        </div>
      </section>
      <div
        className="rounded border border-white/10 bg-black/20 p-2 text-[10px] leading-relaxed text-deck-muted"
        data-permission-field="grok.settings-note"
      >
        这里只显示 Grok Build 实际使用的权限设置；Claude 和 Codex 的设置不会混入这里。
      </div>
    </div>
  );
}
