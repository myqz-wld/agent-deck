import { useEffect, useRef } from 'react';
import { isTerminalNativeWork, nativeWorkAttemptKey } from '@shared/native-work';
import { useWorkRailGestures } from './useWorkRailGestures';
import { NativeWorkCard, CardSummary } from './NativeWorkCard';
import type { NativeWorkView } from './useNativeWork';
import './native-work.css';
export function NativeWorkStrip({ view }: { view: NativeWorkView }) {
  if (!view.visible.length) return null;
  return <TaskCards view={view} />;
}
function TaskCards({ view }: { view: NativeWorkView }) {
  const tasks = view.visible;
  const scroll = useWorkRailGestures({ ids: tasks.map(task => nativeWorkAttemptKey(task.native)),
    onDismiss: view.dismiss, onReorder: view.reorder, onStopAndDismiss: key => {
      const task = tasks.find(task => nativeWorkAttemptKey(task.native) === key); if (task) void view.stop(task, true);
    } });
  const collapse = useRef(view.collapse); collapse.current = view.collapse;
  const collapseVersion = useRef(scroll.collapseVersion);
  useEffect(() => { if (collapseVersion.current !== scroll.collapseVersion) { collapseVersion.current = scroll.collapseVersion; collapse.current(); } }, [scroll.collapseVersion]);
  const active = tasks.filter(task => !isTerminalNativeWork(task.status)).length;
  const drag = scroll.drag, draggedTask = drag && tasks.find(task => nativeWorkAttemptKey(task.native) === drag.id);
  const ordered = scroll.order ? scroll.order.flatMap(key => tasks.filter(task => nativeWorkAttemptKey(task.native) === key)) : tasks;
  return <section className="execution-rail" aria-label="子代理任务栏">
    <div className="rail-heading"><span>子代理</span><span className="text-deck-muted/55">{active} 未结束 · {tasks.length - active} 已结束</span>
      {view.error && <span role="status">{view.error}</span>}</div>
    <div ref={scroll.ref} className="work-scroll" role="list" aria-label="子代理" {...scroll.handlers}>
      {ordered.map(task => <NativeWorkCard key={nativeWorkAttemptKey(task.native)} task={task} view={view} scrollRef={scroll.ref} dismissing={drag?.id === nativeWorkAttemptKey(task.native)} />)}
    </div>
    {drag && draggedTask && <div aria-hidden className="work-dismiss-ghost work-card" style={{ left: drag.left, top: drag.top, width: drag.width,
      transform: `translate(${drag.dx}px, ${drag.dy}px)`, opacity: drag.ready ? .6 : .95 }}><div className="work-card-toggle">
      <CardSummary task={draggedTask} actionLabel={drag.ready ? drag.terminal ? '松开关闭展示' : '松开停止并关闭展示' : undefined} />
    </div></div>}
  </section>;
}
