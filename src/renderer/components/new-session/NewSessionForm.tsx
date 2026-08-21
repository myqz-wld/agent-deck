import { useLayoutEffect, useRef, type JSX, type ReactNode } from 'react';

import type { DeckSelectOption } from '@renderer/components/DeckSelect';
import { DeckSelect } from '@renderer/components/DeckSelect';
import { SessionModelDisclosure } from '@renderer/components/SessionModelDisclosure';
import type { SessionThinkingChoice } from '@renderer/components/SessionModelFields';
import {
  useDelayedAsyncFallback,
  useInitialAsyncPresentation,
} from '@renderer/hooks/useDelayedAsyncFallback';
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
  /** A later configuration projection is unresolved; keep the committed form mounted. */
  configurationPending?: boolean;
  /** Closed Remote schemas must not be edited while their authority is being refreshed. */
  configurationControlsBlocked?: boolean;
  /** Authoritative configuration must settle before the current form may be submitted. */
  configurationSubmissionBlocked?: boolean;
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
  onRetryConfiguration?: () => void;
  onWorkingDirectoryChange(value: string): void;
}

const SELECT_CLASS =
  'w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px] outline-none focus:border-white/20';

export function NewSessionForm(props: Props): JSX.Element | null {
  const presentation = useInitialAsyncPresentation(
    props.initializing === true,
    props.authoringId,
  );
  const contentReady = presentation === 'ready';
  const configurationPending = props.configurationPending === true;
  const showConfigurationProgress = useDelayedAsyncFallback(
    contentReady && configurationPending,
    `${props.authoringId}:configuration`,
  );
  const disabled = props.busy;
  const configurationDisabled = disabled || props.configurationControlsBlocked === true;
  const preparingConfiguration = !disabled && props.configurationSubmissionBlocked === true;
  const submissionDisabled = disabled || preparingConfiguration;
  const settledCanCreateRef = useRef(props.canCreate);
  useLayoutEffect(() => {
    if (!preparingConfiguration) settledCanCreateRef.current = props.canCreate;
  }, [preparingConfiguration, props.canCreate]);
  const visuallyCanCreate = preparingConfiguration && !showConfigurationProgress
    ? settledCanCreateRef.current
    : props.canCreate;
  const createButtonVisuallyDisabled = disabled || !visuallyCanCreate || (
    preparingConfiguration && showConfigurationProgress
  );
  const createLabel = props.createLabel ?? '创建';
  const creatingLabel = props.creatingLabel ?? '创建中…';
  const titleId = `${props.authoringId.replace(/[^A-Za-z0-9_-]/g, '-')}-title`;
  const modalRootRef = useRef<HTMLDivElement>(null);
  useModalFocus({ blocked: props.busy, dialogRef: modalRootRef, onClose: props.onClose });

  return (
    <div
      ref={modalRootRef}
      tabIndex={-1}
      data-new-session-modal-root
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      {presentation !== 'deferred' && <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={presentation === 'fallback'}
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

        {presentation === 'fallback' ? (
          <div
            role="status"
            aria-live="polite"
            className="flex min-h-40 items-center justify-center text-[11px] text-deck-muted"
          >
            正在读取会话配置…
          </div>
        ) : props.adapters.length === 0 ? props.error ? (
          <FormError error={props.error} onRetry={props.onRetryConfiguration} />
        ) : (
          <div className="text-[11px] text-deck-muted">
            没有可用的助手
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {props.sourceLabel && (
              <div className="rounded border border-deck-border bg-black/20 px-2.5 py-2 text-[10px] text-deck-muted">
                创建目标：{props.sourceLabel}
              </div>
            )}
            {props.notice}
            <Field label="助手">
              <DeckSelect
                value={props.adapterId}
                onChange={props.onAdapterChange}
                options={props.adapters}
                disabled={configurationDisabled}
                buttonClassName={SELECT_CLASS}
              />
            </Field>

            <SessionModelDisclosure
              adapterId={props.model.adapterId}
              provider={props.model.provider}
              model={props.model.model}
              thinking={props.model.thinking}
              disabled={configurationDisabled}
              providerOptions={props.model.providerOptions}
              thinkingOptions={props.model.thinkingOptions}
              disabledReasons={props.model.disabledReasons}
              onProviderChange={props.model.onProviderChange}
              onModelChange={props.model.onModelChange}
              onThinkingChange={props.model.onThinkingChange}
            />

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
                    disabled={configurationDisabled}
                    ariaLabel="Grok Build 沙盒请求档位"
                  />
                ) : (
                  <DeckSelect
                    value={control.value}
                    onChange={control.onChange}
                    options={control.options}
                    disabled={configurationDisabled}
                    buttonClassName={SELECT_CLASS}
                  />
                )}
              </Field>
            ))}

            {showConfigurationProgress && (
              <div role="status" className="rounded bg-white/[0.035] px-2 py-1 text-[10px] text-deck-muted">
                正在更新会话配置…
              </div>
            )}
            {props.error && (
              <FormError error={props.error} onRetry={props.onRetryConfiguration} />
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
                disabled={!props.canCreate || submissionDisabled}
                title={preparingConfiguration ? '正在读取会话配置' : undefined}
                className={`rounded bg-status-working/30 px-3 py-1 text-[11px] text-status-working hover:bg-status-working/40 ${
                  createButtonVisuallyDisabled ? 'opacity-50' : ''
                }`}
              >
                <span className="inline-grid place-items-center">
                  <span
                    aria-hidden="true"
                    className="invisible col-start-1 row-start-1 inline-flex items-center whitespace-nowrap"
                  >
                    <SendIcon className="mr-1 h-3 w-3" />
                    {createLabel}
                  </span>
                  <span
                    aria-hidden="true"
                    className="invisible col-start-1 row-start-1 whitespace-nowrap"
                  >
                    {creatingLabel}
                  </span>
                  <span className="col-start-1 row-start-1 inline-flex items-center whitespace-nowrap">
                    {!props.busy && <SendIcon className="mr-1 h-3 w-3" />}
                    {props.busy ? creatingLabel : createLabel}
                  </span>
                </span>
              </button>
            </div>
          </div>
        )}
      </div>}
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

function FormError({
  error,
  onRetry,
}: {
  error: string;
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div role="alert" className="flex items-center justify-between gap-2 rounded bg-status-waiting/10 px-2 py-1 text-[11px] text-status-waiting">
      <span>{error}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded bg-white/10 px-2 py-0.5 text-deck-text hover:bg-white/15"
        >
          重试读取配置
        </button>
      )}
    </div>
  );
}
