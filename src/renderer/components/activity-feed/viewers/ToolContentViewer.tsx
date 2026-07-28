import { useMemo, type JSX } from 'react';
import type { DiffPayload, ImageSource } from '@shared/types';
import {
  ExpandableContent,
  type DiffContentPayload,
  type ExpandableContentPayload,
  type ExpandableHeavyViewSpec,
  type ImageContentPayload,
  type ToolContentPayload,
} from '@renderer/components/expandable-content';
import { DiffViewer } from '@renderer/components/diff/DiffViewer';
import { ImageBlobLoader } from '@renderer/components/diff/renderers/ImageBlobLoader';
import { formatToolInput } from '../format';
import {
  localDiffContent,
  localImageContent,
  toolPayload,
} from './content-reference';

interface Props {
  sessionId: string;
  eventId: string;
  revision: number;
  toolName: string;
  toolInput: unknown;
  resultValue?: unknown;
  resultText?: string;
  resultStatus: NonNullable<ToolContentPayload['result']>['status'];
  statusLabel: string;
  statusDetail?: string | null;
  duration?: string | null;
  truncation?: string | null;
  diff?: DiffPayload | null;
  image?: {
    source: ImageSource;
    alt: string;
    mediaType?: string;
    width?: number;
    height?: number;
    description?: string;
    provider?: string;
    model?: string;
  } | null;
  triggerClassName?: string;
}

export function ToolContentViewer(props: Props): JSX.Element {
  const content = useMemo(() => {
    if (props.diff) {
      return {
        kind: 'diff' as const,
        ...localDiffContent({
          sessionId: props.sessionId,
          eventId: props.eventId,
          toolName: props.toolName,
          diff: props.diff,
          statusLabel: props.statusLabel,
          truncation: props.truncation,
        }),
      };
    }
    if (props.image) {
      return {
        kind: 'image' as const,
        ...localImageContent({
          sessionId: props.sessionId,
          eventId: props.eventId,
          ...props.image,
        }),
      };
    }
    return {
      kind: 'tool' as const,
      payload: toolPayload({
        toolName: props.toolName,
        toolInput: props.toolInput,
        resultStatus: props.resultStatus,
        resultValue: props.resultValue,
        resultText: props.resultText,
        statusLabel: props.statusLabel,
        statusDetail: props.statusDetail,
        duration: props.duration,
        truncation: props.truncation,
      }),
    };
  }, [
    props.diff,
    props.duration,
    props.eventId,
    props.image,
    props.resultStatus,
    props.resultText,
    props.resultValue,
    props.sessionId,
    props.statusDetail,
    props.statusLabel,
    props.toolInput,
    props.toolName,
    props.truncation,
  ]);
  const payload: ExpandableContentPayload = content.payload;

  const heavyView = useMemo<ExpandableHeavyViewSpec | undefined>(() => {
    if (content.kind === 'diff') {
      return {
        id: `tool-diff-${props.sessionId}-${props.eventId}`,
        kind: content.payload.reference.presentation === 'image-diff' ? 'image-diff' : 'monaco',
        render: () => {
          const resolved = content.resolve(content.payload.reference);
          return resolved ? (
            <div className="min-h-[20rem] flex-1">
              <DiffViewer payload={resolved} sessionId={props.sessionId} expanded />
            </div>
          ) : <UnavailableContent />;
        },
      };
    }
    if (content.kind === 'image') {
      return {
        id: `tool-image-${props.sessionId}-${props.eventId}`,
        kind: 'image',
        render: () => {
          const source = content.resolve(content.payload.reference);
          return source ? (
            <ImageBlobLoader sessionId={props.sessionId} source={source}>
              {({ loading, result }) => {
                if (loading) {
                  return <div className="h-full min-h-64 animate-pulse rounded bg-white/[0.03]" />;
                }
                if (!result?.ok) {
                  return (
                    <div className="flex min-h-64 items-center justify-center text-sm text-deck-muted">
                      图片无法显示{result && !result.ok ? `：${result.reason}` : ''}
                    </div>
                  );
                }
                return (
                  <img
                    src={result.dataUrl}
                    alt={content.payload.reference.alt}
                    className="mx-auto max-h-full max-w-full object-contain"
                  />
                );
              }}
            </ImageBlobLoader>
          ) : <UnavailableContent />;
        },
      };
    }
    return undefined;
  }, [content, props.eventId, props.sessionId]);

  return (
    <ExpandableContent
      identity={{
        sessionId: props.sessionId,
        kind: 'event',
        eventId: props.eventId,
        revision: props.revision,
      }}
      payload={payload}
      title={`${props.toolName} 详情`}
      triggerLabel={`展开 ${props.toolName} 详情`}
      triggerClassName={props.triggerClassName}
      heavyView={heavyView}
    >
      <ToolDetails {...props} payload={payload} />
    </ExpandableContent>
  );
}

function UnavailableContent(): JSX.Element {
  return (
    <div className="flex min-h-64 items-center justify-center text-sm text-deck-muted">
      内容引用已失效
    </div>
  );
}

function ToolDetails({
  toolName,
  toolInput,
  resultText,
  statusLabel,
  statusDetail,
  duration,
  truncation,
  payload,
}: Props & { payload: ExpandableContentPayload }): JSX.Element {
  return (
    <div className="mb-3 min-w-0 space-y-3 text-sm">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 rounded border border-deck-border bg-white/[0.02] p-3">
        <dt className="text-deck-muted">工具</dt>
        <dd className="break-all font-mono">{toolName}</dd>
        <dt className="text-deck-muted">状态</dt>
        <dd>
          {statusLabel}
          {statusDetail ? ` · ${statusDetail}` : ''}
        </dd>
        {duration && <><dt className="text-deck-muted">耗时</dt><dd>{duration}</dd></>}
        {truncation && <><dt className="text-deck-muted">完整性</dt><dd>{truncation}</dd></>}
        {(payload.kind === 'diff' || payload.kind === 'image') && (
          <><dt className="text-deck-muted">内容类型</dt><dd>{typedKindLabel(payload)}</dd></>
        )}
      </dl>
      <section>
        <h3 className="mb-1 text-xs text-deck-muted">完整输入</h3>
        <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-3 text-xs scrollbar-deck">
          {formatToolInput(toolInput)}
        </pre>
      </section>
      {resultText !== undefined && (
        <section>
          <h3 className="mb-1 text-xs text-deck-muted">完整结果</h3>
          <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-3 text-xs scrollbar-deck">
            {resultText || '（无输出）'}
          </pre>
        </section>
      )}
    </div>
  );
}

function typedKindLabel(payload: DiffContentPayload | ImageContentPayload): string {
  if (payload.kind === 'image') return '图片';
  return payload.reference.presentation === 'image-diff' ? '图片差异' : '文本差异';
}
