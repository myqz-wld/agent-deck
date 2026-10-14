import { useRef, useState, type JSX } from 'react';
import type { MessageDeliveryRecovery } from '@shared/message-delivery-recovery';
import { UploadedImageThumb } from '../../UploadedImageThumb';
import { ImageLightbox } from '../../ImageLightbox';

/** Recovery remains explicit: preserve evidence and send only on an owner click. */
export function MessageRecoveryRow({ recovery, showAttachments = true, onResend }: {
  recovery: MessageDeliveryRecovery;
  showAttachments?: boolean;
  onResend?: () => Promise<void>;
}): JSX.Element {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [lightboxPath, setLightboxPath] = useState<string | null>(null);
  const unknown = recovery.status === 'unknown';
  const disabledReason = !onResend ? '当前来源不支持在这里重新发送，请在来源端恢复消息。'
    : recovery.textTruncated ? '原文不完整，无法直接重新发送。'
      : recovery.attachments.length !== recovery.attachmentCount ? '附件记录不完整，请重新添加图片后发送。'
        : !recovery.text && !recovery.attachmentCount ? '没有可重新发送的内容。' : null;
  const resend = async (): Promise<void> => {
    if (!onResend || disabledReason || inFlight.current || sent) return;
    inFlight.current = true;
    setSending(true);
    setError(null);
    try {
      await onResend();
      setSent(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '重新发送失败，请稍后重试。');
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };
  return <li className="min-w-0 rounded-md border border-status-waiting/30 bg-status-waiting/[0.05] p-2.5">
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      <span className="font-medium text-status-waiting">
        {unknown ? '消息送达情况未知，原文已保留' : '消息未发送，原文已保留'}
      </span>
      <button type="button" onClick={() => void resend()} disabled={sending || sent || !!disabledReason}
        title={disabledReason ?? undefined} aria-busy={sending}
        className="ml-auto rounded bg-white/5 px-2 py-1 text-deck-text hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50">
        {sending ? '发送中…' : sent ? '已加入队列' : '重新发送'}
      </button>
    </div>
    <p className="mt-1 text-[10px] text-deck-muted">
      {unknown ? 'Claude 未确认接收。请先检查后续回复，再决定是否重新发送，以免重复执行。'
        : '会话结束时，这条消息仍在等待发送。重新发送会一并提交原文和附件。'}
    </p>
    {recovery.textTruncated && <p className="mt-1 text-[10px] text-status-waiting">
      当前只显示部分原文，请在消息来源处恢复完整内容。
    </p>}
    {recovery.text && <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words text-[11px] text-deck-text select-text">
      {recovery.text}
    </pre>}
    {recovery.attachmentCount > 0 && <div className="mt-2 text-[10px] text-deck-muted">
      已保留 {recovery.attachmentCount} 个附件的记录
      {showAttachments && recovery.attachments.length > 0
        ? <div className="mt-1 flex flex-wrap gap-1.5">{recovery.attachments.map((attachment, index) =>
          <button key={`${attachment.path}:${index}`} type="button" aria-label={`查看待恢复附件 ${index + 1}`}
            className="rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-deck-muted"
            onClick={() => setLightboxPath(attachment.path)}>
            <UploadedImageThumb path={attachment.path} size={64} alt={`待恢复附件 ${index + 1}`}
              onClick={() => setLightboxPath(attachment.path)} />
          </button>)}</div>
        : <div>当前来源不支持直接预览这些附件，重新发送时请再次添加图片。</div>}
    </div>}
    {disabledReason && <div className="mt-1 text-[10px] text-deck-muted">{disabledReason}</div>}
    {sent && <div role="status" className="mt-1 text-[10px] text-deck-muted">已加入发送队列，等待 Claude 确认接收。</div>}
    {error && <div role="alert" className="mt-1 text-[10px] text-status-waiting">重新发送失败：{error}</div>}
    {showAttachments && lightboxPath && <ImageLightbox path={lightboxPath} alt="待恢复附件"
      onClose={() => setLightboxPath(null)} />}
  </li>;
}
