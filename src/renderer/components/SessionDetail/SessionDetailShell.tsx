import { useEffect, useState, type FormEvent, type JSX, type ReactNode } from 'react';

import type { RemoteHostJsonObject } from '@shared/remote-host';
import { ArrowLeftIcon } from '../icons';

export type SessionDetailTabId =
  | 'activity'
  | 'tasks'
  | 'diff'
  | 'summary'
  | 'messages'
  | 'pending'
  | 'runtime'
  | 'permissions';

export interface SessionDetailTabModel {
  id: SessionDetailTabId;
  label: string;
  content: ReactNode;
  unavailableReason?: string;
}

export function SessionDetailShell({
  title,
  sourceBadge,
  subtitle,
  metadata,
  headerActions,
  banner,
  notice,
  tabs,
  activeTab,
  onTabChange,
  alert,
  composer,
  overlay,
  onClose,
}: {
  title: string;
  sourceBadge: ReactNode;
  subtitle: string;
  metadata?: ReactNode;
  headerActions?: ReactNode;
  banner?: ReactNode;
  notice?: ReactNode;
  tabs: readonly SessionDetailTabModel[];
  activeTab: SessionDetailTabId;
  onTabChange: (tab: SessionDetailTabId) => void;
  alert?: ReactNode;
  composer: ReactNode;
  overlay?: ReactNode;
  onClose: () => void;
}): JSX.Element {
  const selected = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];
  return (
    <div data-session-detail-shell className="flex h-full min-w-0 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center justify-between border-b border-deck-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {sourceBadge}
            <div className="truncate text-[12px] font-medium">{title}</div>
          </div>
          <div className="truncate text-[10px] text-deck-muted">{subtitle}</div>
          {metadata && <div className="mt-1 flex flex-wrap items-center gap-1">{metadata}</div>}
        </div>
        <div className="ml-2 flex shrink-0 items-center gap-1">
          {headerActions}
          <button type="button" onClick={onClose} className="flex h-5 w-5 items-center justify-center rounded text-deck-muted hover:bg-white/10" title="返回列表" aria-label="返回列表">
            <ArrowLeftIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>
      {banner}
      {notice}
      <nav className="flex shrink-0 gap-1 border-b border-deck-border/60 px-2 py-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            title={tab.unavailableReason}
            className={`rounded px-2 py-1 text-[11px] ${
              selected?.id === tab.id
                ? 'bg-white/10 text-deck-text'
                : tab.unavailableReason
                  ? 'text-deck-muted/60 hover:bg-white/5'
                  : 'text-deck-muted hover:bg-white/5'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-deck px-3 py-2">
        {selected?.unavailableReason
          ? <SessionCapabilityPlaceholder reason={selected.unavailableReason} />
          : selected?.content}
      </div>
      {alert}
      {composer}
      {overlay}
    </div>
  );
}

export function SessionCapabilityPlaceholder({ reason }: { reason: string }): JSX.Element {
  return (
    <div className="mx-auto max-w-lg py-12 text-center text-[10px] leading-relaxed text-deck-muted">
      {reason}
    </div>
  );
}

export function SessionPendingPanel({ children }: { children: ReactNode }): JSX.Element {
  return <div className="mx-auto max-w-3xl">{children}</div>;
}

export function SessionRuntimePanel({
  identity,
  values,
  busy,
  canWrite,
  onApply,
  onError,
}: {
  identity: string;
  values: RemoteHostJsonObject | null;
  busy: boolean;
  canWrite: boolean;
  onApply: (patch: RemoteHostJsonObject) => Promise<void>;
  onError: (reason: unknown) => void;
}): JSX.Element {
  const [patch, setPatch] = useState('{}');
  useEffect(() => setPatch('{}'), [identity]);
  const apply = async (): Promise<void> => {
    try {
      const value = JSON.parse(patch) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('运行时 patch 必须是 JSON 对象。');
      }
      await onApply(value as RemoteHostJsonObject);
      setPatch('{}');
    } catch (reason) {
      onError(reason);
    }
  };
  return (
    <div className="mx-auto max-w-2xl">
      <pre className="max-h-64 overflow-auto rounded bg-black/20 p-2 text-[10px] text-deck-muted">{JSON.stringify(values ?? {}, null, 2)}</pre>
      <textarea aria-label="运行时 patch JSON" value={patch} onChange={(event) => setPatch(event.target.value)} rows={5} disabled={!canWrite} className="mt-2 w-full resize-y rounded border border-white/10 bg-black/20 p-2 font-mono text-[10px] disabled:opacity-40" />
      <button type="button" disabled={busy || !canWrite || !values} onClick={() => void apply()} className="mt-1 rounded bg-white/8 px-3 py-1 text-[10px] disabled:opacity-40">应用 patch</button>
    </div>
  );
}

export function SessionTextComposer({
  identity,
  busy,
  canWrite,
  onSend,
  onSteer,
  onInterrupt,
  onError,
}: {
  identity: string;
  busy: boolean;
  canWrite: boolean;
  onSend: (text: string) => Promise<void>;
  onSteer: (text: string) => Promise<void>;
  onInterrupt: () => Promise<void>;
  onError: (reason: unknown) => void;
}): JSX.Element {
  const [text, setText] = useState('');
  useEffect(() => setText(''), [identity]);
  const perform = async (operation: () => Promise<void>, clear: boolean): Promise<void> => {
    try {
      await operation();
      if (clear) setText('');
    } catch (reason) {
      onError(reason);
    }
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const message = text.trim();
    if (message) void perform(() => onSend(message), true);
  };
  return (
    <form onSubmit={submit} className="shrink-0 border-t border-deck-border p-2">
      <textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} disabled={!canWrite} placeholder={canWrite ? '发送到当前 session…' : '此数据源未提供 session 写入能力'} className="w-full resize-none rounded border border-white/10 bg-black/20 p-2 text-[11px] disabled:opacity-40" />
      <div className="mt-1 flex justify-between gap-1">
        <button type="button" disabled={busy || !canWrite || !text.trim()} onClick={() => void perform(() => onSteer(text.trim()), true)} className="rounded px-2 py-1 text-[9px] text-deck-muted hover:bg-white/8 disabled:opacity-30">作为 steer 发送</button>
        <div className="flex gap-1">
          <button type="button" disabled={busy || !canWrite} onClick={() => void perform(onInterrupt, false)} className="rounded px-2 py-1 text-[9px] text-amber-200 disabled:opacity-30">中断 turn</button>
          <button type="submit" disabled={busy || !canWrite || !text.trim()} className="rounded bg-blue-500 px-3 py-1 text-[10px] text-white disabled:opacity-40">发送</button>
        </div>
      </div>
    </form>
  );
}
