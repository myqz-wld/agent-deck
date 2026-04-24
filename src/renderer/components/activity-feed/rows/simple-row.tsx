import type { JSX } from 'react';
import type { AgentEvent } from '@shared/types';
import { describe } from '../describe';

/** 兜底：单行带状态点 + 中文摘要 + 时间戳。所有未被特化处理的 event kind 都走这里。 */
export function SimpleRow({ event }: { event: AgentEvent }): JSX.Element {
  return (
    <li className="flex items-start gap-2 text-[11px]">
      <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-deck-muted/60" />
      <div className="flex-1 leading-relaxed">
        <div className="text-deck-text">{describe(event)}</div>
        <div className="mt-0.5 text-[9px] text-deck-muted/60">
          {new Date(event.ts).toLocaleTimeString('zh-CN', { hour12: false })}
        </div>
      </div>
    </li>
  );
}
