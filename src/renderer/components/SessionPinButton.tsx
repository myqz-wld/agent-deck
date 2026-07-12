import { useRef, useState, type JSX, type MouseEvent } from 'react';
import type { SessionRecord } from '@shared/types';
import log from '@renderer/utils/logger';
import { PushpinIcon } from './icons';

const logger = log.scope('renderer-session-pin-button');

interface Props {
  session: SessionRecord;
}

/**
 * 会话置顶按钮。置顶状态只读取实时 SessionRecord；IPC 成功前不做乐观更新，避免失败时
 * 显示一个并未持久化的状态。busyRef 是同步锁，覆盖 React 提交 disabled 前的超快连点。
 */
export function SessionPinButton({ session }: Props): JSX.Element {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const pinned = session.pinnedAt != null;
  const label = pinned ? '取消置顶会话' : '置顶会话';

  const togglePinned = async (event: MouseEvent<HTMLButtonElement>): Promise<void> => {
    event.stopPropagation();
    if (busyRef.current) return;

    busyRef.current = true;
    setBusy(true);
    try {
      await window.api.setSessionPinned(session.id, !pinned);
    } catch (error) {
      logger.warn(`[session-pin] failed for ${session.id}:`, error);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      disabled={busy}
      aria-label={label}
      aria-pressed={pinned}
      title={label}
      onClick={(event) => void togglePinned(event)}
      onContextMenu={(event) => event.stopPropagation()}
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-[11px] transition ${
        pinned
          ? 'bg-amber-400/15 text-amber-300 hover:bg-amber-400/25'
          : 'text-deck-muted/70 hover:bg-white/10 hover:text-deck-text'
      } ${busy ? 'cursor-wait opacity-50' : ''}`}
    >
      <PushpinIcon filled={pinned} className="h-3.5 w-3.5" />
    </button>
  );
}
