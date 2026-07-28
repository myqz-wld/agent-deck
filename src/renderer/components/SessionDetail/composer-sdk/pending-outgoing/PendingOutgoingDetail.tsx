import { useEffect, useRef, useState, type JSX } from 'react';
import type {
  PendingOutgoingAttachmentLoadResult,
  PendingOutgoingMessage,
} from '@shared/types';
import { DataUrlImageLightbox } from '@renderer/components/ImageLightbox';

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function PendingOutgoingDetail({
  agentId,
  sessionId,
  message,
}: {
  agentId: string;
  sessionId: string;
  message: PendingOutgoingMessage;
}): JSX.Element {
  const resultsRef = useRef(new Map<string, PendingOutgoingAttachmentLoadResult>());
  const requestGenerationRef = useRef(0);
  const [, setVersion] = useState(0);
  const [previewId, setPreviewId] = useState<string | null>(null);

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    resultsRef.current.clear();
    setPreviewId(null);
    for (const attachment of message.attachments) {
      void window.api.loadPendingOutgoingAttachment(
        agentId,
        sessionId,
        message.id,
        attachment.id,
      ).then((result) => {
        if (generation !== requestGenerationRef.current) return;
        resultsRef.current.set(attachment.id, result);
        setVersion((version) => version + 1);
      }).catch(() => {
        if (generation !== requestGenerationRef.current) return;
        resultsRef.current.set(attachment.id, {
          ok: false,
          reason: 'io_error',
        });
        setVersion((version) => version + 1);
      });
    }
    return () => {
      requestGenerationRef.current += 1;
      resultsRef.current.clear();
    };
  }, [agentId, message, sessionId]);

  const preview = previewId ? resultsRef.current.get(previewId) : undefined;
  return (
    <>
      <div className="space-y-4">
        <section>
          <h3 className="mb-1 text-xs font-medium text-deck-muted">完整消息</h3>
          <div className="whitespace-pre-wrap break-words rounded border border-deck-border bg-black/20 p-3 text-sm">
            {message.text || '无文字（仅附件）'}
          </div>
        </section>
        <section>
          <h3 className="mb-2 text-xs font-medium text-deck-muted">
            附件 · {message.attachments.length}
          </h3>
          {message.attachments.length === 0 ? (
            <div className="rounded border border-deck-border bg-black/20 p-3 text-xs text-deck-muted">
              这条等待消息没有附件。
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {message.attachments.map((attachment, index) => {
                const result = resultsRef.current.get(attachment.id);
                return (
                  <article
                    key={attachment.id}
                    className="overflow-hidden rounded border border-deck-border bg-black/20"
                  >
                    <div className="flex aspect-video items-center justify-center bg-black/20">
                      {!result && <span className="text-xs text-deck-muted">图片加载中…</span>}
                      {result?.ok && (
                        <button
                          type="button"
                          onClick={() => setPreviewId(attachment.id)}
                          className="h-full w-full cursor-zoom-in"
                          aria-label={`放大查看等待附件 ${index + 1}`}
                        >
                          <img
                            src={result.dataUrl}
                            alt={`等待附件 ${index + 1}`}
                            className="h-full w-full object-contain"
                          />
                        </button>
                      )}
                      {result && !result.ok && (
                        <span role="status" className="px-3 text-center text-xs text-deck-muted">
                          {result.reason === 'not_found'
                            ? '附件已被接收或删除，无法继续预览。'
                            : '图片加载失败，请关闭后重试。'}
                        </span>
                      )}
                    </div>
                    <div className="space-y-0.5 border-t border-deck-border px-2 py-1.5 text-[10px]">
                      <div>附件 {index + 1}</div>
                      <div className="text-deck-muted">{attachment.mime}</div>
                      <div className="text-deck-muted">{formatBytes(attachment.bytes)}</div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
      {preview?.ok && (
        <DataUrlImageLightbox
          dataUrl={preview.dataUrl}
          alt="等待消息附件预览"
          onClose={() => setPreviewId(null)}
        />
      )}
    </>
  );
}
