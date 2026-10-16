import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { isTerminalNativeWork, nativeWorkAttemptKey, type NativeWorkSnapshot } from '@shared/native-work';
import { ChevronDownIcon, StopIcon } from '../icons';
import { NativeWorkDetails } from './NativeWorkDetails';
import type { NativeWorkView } from './useNativeWork';
export function CardSummary({ task, expanded = false, actionLabel }: { task: NativeWorkSnapshot; expanded?: boolean; actionLabel?: string }) {
  const labels = { pending: '准备中', running: '运行中', paused: '已暂停', completed: '已完成', failed: '失败', stopped: '已停止', unknown: '状态待确认' };
  const provider = { 'claude-code': 'Claude', 'codex-cli': 'Codex', 'grok-build': 'Grok' }[task.native.provider];
  const duration = Math.max(0, Math.floor(((isTerminalNativeWork(task.status) ? task.updatedAt : Date.now()) - task.startedAt) / 1000));
  return <>
    <span className="work-card-title"><span className={`work-dot ${task.status}`} /><span className="min-w-0 flex-1 truncate">{task.description || '执行任务'}</span>
      <ChevronDownIcon className={`h-3 w-3 shrink-0 text-deck-muted/40 ${expanded ? '' : 'rotate-180'}`} /></span>
    <span className="work-card-meta"><span className="work-kind">{provider} · {task.workKind === 'subagent' ? '子代理' : '后台命令'}</span>
      <span className="truncate">{actionLabel ?? labels[task.status]}</span><span className="ml-auto shrink-0 tabular-nums">{duration}s</span></span>
  </>;
}
interface Placement { host: HTMLElement; left: number; bottom: number; width: number; maxHeight: number; visible: boolean }
export function NativeWorkCard({ task, view, scrollRef, dismissing }: {
  task: NativeWorkSnapshot; view: NativeWorkView; scrollRef: RefObject<HTMLDivElement | null>; dismissing: boolean;
}) {
  const key = nativeWorkAttemptKey(task.native), expanded = view.preferences.expanded.includes(key);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const pending = view.pendingKeys.includes(key), failure = view.errors[key];
  useLayoutEffect(() => {
    if (!expanded || dismissing) return;
    // Child layout effects can run before the strip's parent ref is attached on remount.
    const card = ref.current, scroll = scrollRef.current ?? card?.parentElement, host = scroll?.parentElement;
    const activity = host?.closest('[data-session-detail-shell]')?.querySelector('[data-session-chat-area]');
    if (!card || !scroll || !host || !activity) return;
    const measure = () => {
      const box = card.getBoundingClientRect(), root = host.getBoundingClientRect(), viewport = scroll.getBoundingClientRect(), chat = activity.getBoundingClientRect();
      setPlacement({ host, left: Math.max(0, Math.min(box.left - root.left, root.width - box.width)),
        bottom: root.bottom - box.top + 4, width: box.width,
        maxHeight: Math.max(0, Math.min(chat.height, box.top - chat.top - 6)),
        visible: Math.min(box.right, viewport.right) - Math.max(box.left, viewport.left) > 40 });
    };
    measure(); const observer = new ResizeObserver(measure);
    [card, host, activity].forEach(node => observer.observe(node)); window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [expanded, dismissing, scrollRef]);
  const detail = expanded && !dismissing && placement?.visible && placement.maxHeight > 0 && view.transport && createPortal(
    <div className="work-popover" data-no-drag role="region" aria-label={`${task.description}详情`}
      style={{ left: placement.left, bottom: placement.bottom, width: placement.width, maxHeight: placement.maxHeight }}
      onKeyDown={event => { if (event.key === 'Escape') { view.expand(key, false); ref.current?.querySelector('button')?.focus(); } }}>
      <div className="flex shrink-0 items-center gap-2 border-b border-deck-border px-2 py-1.5 text-[10px]">
        <span className="min-w-0 flex-1 truncate">{task.description}</span>
        {!isTerminalNativeWork(task.status) && <button className="rail-action" disabled={pending || !task.canStop}
          title={task.controlReason} onClick={() => void view.stop(task, false)}><StopIcon className="h-3 w-3" />{pending ? '停止中…' : '停止'}</button>}
      </div>
      <div className="work-popover-body scrollbar-deck">
        {!isTerminalNativeWork(task.status) && !task.canStop && <p className="mb-2 text-[10px] text-deck-muted">{task.controlReason ?? '当前运行实例不支持单独停止'}</p>}
        {failure && <p role="alert" className="mb-2 text-[10px] text-status-error">{failure.message} <button onClick={() => void view.stop(task, failure.hide)}>重试</button></p>}
        <NativeWorkDetails task={task} transport={view.transport} />
      </div>
    </div>, placement.host);
  return <div ref={ref} className="work-card-slot" data-work-id={key} data-dismissible={isTerminalNativeWork(task.status)} data-dismissing={dismissing} role="listitem">
    <div className="work-card"><button className="work-card-toggle" aria-expanded={expanded}
      aria-label={`${expanded ? '收起' : '展开'}${task.description}详情`} onClick={() => view.expand(key, !expanded)}
      onKeyDown={event => {
        if (event.key === 'Escape') view.expand(key, false);
        if ((event.key === 'Delete' || event.key === 'Backspace') && isTerminalNativeWork(task.status)) { event.preventDefault(); view.dismiss(key); }
      }}><CardSummary task={task} expanded={expanded} actionLabel={failure ? '停止未成功 · 点击重试' : pending ? '停止中…' : undefined} /></button></div>
    {detail}
  </div>;
}
