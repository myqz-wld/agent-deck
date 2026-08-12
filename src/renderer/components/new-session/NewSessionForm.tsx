import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';

import type { DeckSelectOption } from '@renderer/components/DeckSelect';
import { DeckSelect } from '@renderer/components/DeckSelect';
import { SessionModelDisclosure } from '@renderer/components/SessionModelDisclosure';
import type { SessionThinkingChoice } from '@renderer/components/SessionModelFields';
import { useDelayedAsyncFallback } from '@renderer/hooks/useDelayedAsyncFallback';
import type { UseImageAttachmentsResult } from '@renderer/hooks/useImageAttachments';
import { CloseIcon, FolderOpenIcon, SendIcon } from '../icons';
import { GrokSandboxPicker } from '../GrokSandboxPicker';
import { FirstMessageAuthoring } from './FirstMessageAuthoring';
import { useModalFocus } from '../use-modal-focus';

export interface NewSessionSelectControl {
  label: string;
  options: readonly DeckSelectOption<string>[];
  value: string;
  onChange(value: string): void;
  customGrok?: boolean;
  disabledReason?: string | null;
}

export interface NewSessionModelControl {
  adapterId: string;
  model: string;
  provider: string;
  providerClosed: boolean;
  providerOptions?: readonly { id: string; name?: string }[];
  thinking: SessionThinkingChoice;
  thinkingOptions?: readonly DeckSelectOption<SessionThinkingChoice>[];
  disabledReasons?: {
    provider?: string | null;
    model?: string | null;
    thinking?: string | null;
  };
  onModelChange(value: string): void;
  onProviderChange(value: string): void;
  onThinkingChange(value: SessionThinkingChoice): void;
}

interface Props {
  acceptsAttachments: boolean;
  adapterId: string;
  adapters: readonly DeckSelectOption<string>[];
  attachmentReason: string | null;
  authoringId: string;
  busy: boolean;
  canCreate: boolean;
  controls: readonly NewSessionSelectControl[];
  directoryHelp?: ReactNode;
  directoryPlaceholder: string;
  error: string | null;
  images: UseImageAttachmentsResult;
  /** Mark the first projection as incomplete until authoritative runtime defaults settle. */
  initializing?: boolean;
  loading: boolean;
  modelLoading?: boolean;
  notice?: ReactNode;
  sourceLabel?: string;
  title?: string;
  createLabel?: string;
  creatingLabel?: string;
  model: NewSessionModelControl;
  pickingDirectory: boolean;
  prompt: string;
  workingDirectory: string;
  onAdapterChange(value: string): void;
  onBrowseDirectory?: () => void;
  onClose(): void;
  onCreate(): void;
  onPromptChange(value: string): void;
  onWorkingDirectoryChange(value: string): void;
}

const SELECT_CLASS =
  'w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px] outline-none focus:border-white/20';

export function NewSessionForm(props: Props): JSX.Element | null {
  const [initiallyReady, setInitiallyReady] = useState(props.initializing !== true);
  const contentReady = initiallyReady || props.initializing !== true;
  const showLoading = useDelayedAsyncFallback(!contentReady, props.authoringId);
  const visible = contentReady || showLoading;
  const disabled = props.busy || props.loading;
  const defaultsDisabled = disabled || props.modelLoading === true;
  const titleId = `${props.authoringId.replace(/[^A-Za-z0-9_-]/g, '-')}-title`;
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus({ blocked: props.busy, dialogRef, onClose: props.onClose, open: visible });
  useEffect(() => {
    if (props.initializing !== true) setInitiallyReady(true);
  }, [props.initializing]);

  if (!visible) return null;
  if (!contentReady) {
    return (
      <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
        <div
          ref={dialogRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="no-drag flex min-h-52 w-[min(28rem,92vw)] flex-col rounded-xl border border-deck-border bg-deck-bg-strong p-4 shadow-2xl"
        >
          <header className="mb-3 flex items-center justify-between">
            <h2 id={titleId} className="text-[13px] font-medium">{props.title ?? '新建会话'}</h2>
            <button
              type="button"
              onClick={props.onClose}
              aria-label="关闭新建会话"
              className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10"
            >
              <CloseIcon className="h-3.5 w-3.5" />
            </button>
          </header>
          <div className="flex flex-1 items-center justify-center text-[11px] text-deck-muted">
            正在读取会话配置…
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="no-drag max-h-[85%] w-[min(28rem,92vw)] overflow-y-auto scrollbar-deck rounded-xl border border-deck-border bg-deck-bg-strong p-4 shadow-2xl"
      >
        <header className="mb-3 flex items-center justify-between">
          <h2 id={titleId} className="text-[13px] font-medium">{props.title ?? '新建会话'}</h2>
          <button
            type="button"
            onClick={props.onClose}
            disabled={props.busy}
            aria-label="关闭新建会话"
            className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </header>

        {props.adapters.length === 0 ? (
          <div className={props.error ? 'text-[11px] text-status-waiting' : 'text-[11px] text-deck-muted'}>
            {props.error ?? (props.loading || props.modelLoading
              ? '正在读取运行时配置…'
              : '没有可用的运行时')}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {props.sourceLabel && (
              <div className="rounded border border-deck-border bg-black/20 px-2.5 py-2 text-[10px] text-deck-muted">
                创建目标：{props.sourceLabel}
              </div>
            )}
            {props.notice}
            <Field label="运行时">
              <DeckSelect
                value={props.adapterId}
                onChange={props.onAdapterChange}
                options={props.adapters}
                disabled={disabled}
                buttonClassName={SELECT_CLASS}
              />
            </Field>

            {props.modelLoading ? (
              <div
                role="status"
                aria-live="polite"
                className="rounded border border-deck-border bg-black/20 px-2 py-1.5 text-[11px] text-deck-muted"
              >
                正在读取模型配置…
              </div>
            ) : (
              <SessionModelDisclosure
                adapterId={props.model.adapterId}
                provider={props.model.provider}
                model={props.model.model}
                thinking={props.model.thinking}
                disabled={defaultsDisabled}
                providerOptions={props.model.providerOptions}
                providerClosed={props.model.providerClosed}
                thinkingOptions={props.model.thinkingOptions}
                disabledReasons={props.model.disabledReasons}
                onProviderChange={props.model.onProviderChange}
                onModelChange={props.model.onModelChange}
                onThinkingChange={props.model.onThinkingChange}
              />
            )}

            <Field label="工作目录">
              <div className="flex gap-1">
                <input
                  type="text"
                  value={props.workingDirectory}
                  onChange={(event) => props.onWorkingDirectoryChange(event.target.value)}
                  placeholder={props.directoryPlaceholder}
                  spellCheck={false}
                  disabled={disabled}
                  className="min-w-0 flex-1 rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20 disabled:opacity-50"
                />
                {props.onBrowseDirectory && (
                  <button
                    type="button"
                    onClick={props.onBrowseDirectory}
                    disabled={disabled || props.pickingDirectory}
                    className="shrink-0 rounded bg-white/10 px-2 text-[10px] hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {!props.pickingDirectory && <FolderOpenIcon className="mr-1 inline h-3 w-3" />}
                    {props.pickingDirectory ? '选择中…' : '选择…'}
                  </button>
                )}
              </div>
              {props.directoryHelp && (
                <div className="text-[10px] leading-relaxed text-deck-muted/70">
                  {props.directoryHelp}
                </div>
              )}
            </Field>

            <FirstMessageAuthoring
              identitySessionId={props.authoringId}
              prompt={props.prompt}
              onPromptChange={props.onPromptChange}
              images={props.images}
              acceptsAttachments={props.acceptsAttachments}
              busy={props.busy}
            />
            {!props.acceptsAttachments && props.attachmentReason && (
              <div className="rounded bg-white/[0.035] px-2 py-1 text-[10px] text-deck-muted">
                {props.attachmentReason}
              </div>
            )}

            {props.controls.map((control) => (
              <Field key={control.label} label={control.label}>
                {control.disabledReason ? (
                  <div
                    role="note"
                    className="break-words rounded border border-white/[0.07] bg-white/[0.03] px-2 py-1.5 text-[10px] leading-relaxed text-deck-muted [overflow-wrap:anywhere]"
                  >
                    不可用：{control.disabledReason}
                  </div>
                ) : control.customGrok ? (
                  <GrokSandboxPicker
                    value={control.value}
                    onChange={control.onChange}
                    allowUnset={false}
                    disabled={defaultsDisabled}
                    ariaLabel="Grok Build 沙盒请求档位"
                  />
                ) : (
                  <DeckSelect
                    value={control.value}
                    onChange={control.onChange}
                    options={control.options}
                    disabled={defaultsDisabled}
                    buttonClassName={SELECT_CLASS}
                  />
                )}
              </Field>
            ))}

            {props.loading && (
              <div className="rounded bg-white/[0.035] px-2 py-1 text-[10px] text-deck-muted">
                正在同步远程运行时配置…
              </div>
            )}
            {props.error && (
              <div role="alert" className="rounded bg-status-waiting/10 px-2 py-1 text-[11px] text-status-waiting">
                {props.error}
              </div>
            )}

            <div className="mt-1 flex justify-end gap-2">
              <button
                type="button"
                onClick={props.onClose}
                disabled={props.busy}
                className="rounded px-3 py-1 text-[11px] text-deck-muted hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
              >
                取消
              </button>
              <button
                type="button"
                onClick={props.onCreate}
                disabled={!props.canCreate || defaultsDisabled}
                className="rounded bg-status-working/30 px-3 py-1 text-[11px] text-status-working hover:bg-status-working/40 disabled:opacity-50"
              >
                {!props.busy && <SendIcon className="mr-1 inline h-3 w-3" />}
                {props.busy ? (props.creatingLabel ?? '创建中…') : (props.createLabel ?? '创建')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-deck-muted/70">{label}</span>
      {children}
    </label>
  );
}
