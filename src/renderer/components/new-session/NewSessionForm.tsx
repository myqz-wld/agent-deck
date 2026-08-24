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
import { InertInteractionBoundary } from '../InertInteractionBoundary';
import { StableButtonContent } from '../StableButtonContent';
import { FirstMessageAuthoring } from './FirstMessageAuthoring';
import { useModalFocus } from '../use-modal-focus';
import type { ProjectTrustDescriptor } from '@shared/types';

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
  projectTrust?: {
    descriptor: ProjectTrustDescriptor;
    grant: boolean;
    onGrantChange(value: boolean): void;
  };
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
  const configurationInteractionBlocked = props.configurationControlsBlocked === true;
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
                disabled={disabled}
                buttonClassName={SELECT_CLASS}
              />
            </Field>

            <InertInteractionBoundary blocked={configurationInteractionBlocked}>
              <SessionModelDisclosure
                adapterId={props.model.adapterId}
                provider={props.model.provider}
                model={props.model.model}
                thinking={props.model.thinking}
                disabled={disabled}
                providerOptions={props.model.providerOptions}
                thinkingOptions={props.model.thinkingOptions}
                disabledReasons={props.model.disabledReasons}
                onProviderChange={props.model.onProviderChange}
                onModelChange={props.model.onModelChange}
                onThinkingChange={props.model.onThinkingChange}
              />
            </InertInteractionBoundary>

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
                    <StableButtonContent
                      activeKey={props.pickingDirectory ? 'busy' : 'idle'}
                      variants={[
                        {
                          key: 'idle',
                          content: <><FolderOpenIcon className="mr-1 h-3 w-3" />选择…</>,
                        },
                        { key: 'busy', content: '选择中…' },
                      ]}
                    />
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
                <InertInteractionBoundary blocked={configurationInteractionBlocked}>
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
                      disabled={disabled}
                      ariaLabel="Grok Build 沙盒请求档位"
                    />
                  ) : (
                    <DeckSelect
                      value={control.value}
                      onChange={control.onChange}
                      options={control.options}
                      disabled={disabled}
                      buttonClassName={SELECT_CLASS}
                    />
                  )}
                </InertInteractionBoundary>
              </Field>
            ))}
            {props.projectTrust && (
              <ProjectTrustControl
                adapterId={props.adapterId}
                descriptor={props.projectTrust.descriptor}
                grant={props.projectTrust.grant}
                disabled={disabled || configurationInteractionBlocked}
                onGrantChange={props.projectTrust.onGrantChange}
              />
            )}
            {props.error && (
              <FormError error={props.error} onRetry={props.onRetryConfiguration} />
            )}

            <div data-new-session-actions className="mt-1 flex items-center gap-2">
              <div className="min-w-0 flex-1">
                {showConfigurationProgress && (
                  <div role="status" className="truncate rounded bg-white/[0.035] px-2 py-1 text-[10px] text-deck-muted">
                    正在更新会话配置…
                  </div>
                )}
              </div>
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
                <StableButtonContent
                  activeKey={props.busy ? 'busy' : 'idle'}
                  variants={[
                    {
                      key: 'idle',
                      content: <><SendIcon className="mr-1 h-3 w-3" />{createLabel}</>,
                    },
                    { key: 'busy', content: creatingLabel },
                  ]}
                />
              </button>
            </div>
          </div>
        )}
      </div>}
    </div>
  );
}

function ProjectTrustControl({
  adapterId,
  descriptor,
  grant,
  disabled,
  onGrantChange,
}: {
  adapterId: string;
  descriptor: ProjectTrustDescriptor;
  grant: boolean;
  disabled: boolean;
  onGrantChange(value: boolean): void;
}): JSX.Element | null {
  if (descriptor.status === 'trusted') return null;
  const help = adapterId === 'claude-code'
    ? '让 Claude 记住你信任这个项目，以后打开时不再询问。即使不勾选，当前会话也可能使用项目中的设置。'
    : adapterId === 'codex-cli'
      ? '允许 Codex 加载项目中的 .codex 配置、hooks 和 rules；工具调用以及新增或修改过的 hooks 仍需单独授权。'
      : '允许 Grok 加载项目中的 MCP、LSP、hooks 和其他代码。请只信任来源可靠的项目。';

  if (descriptor.status === 'untrusted' && descriptor.canGrant) {
    return (
      <div className="rounded border border-deck-border bg-white/[0.025] px-2.5 py-2">
        <label className="flex items-center gap-2 text-[11px] text-deck-text">
          <input
            type="checkbox"
            checked={grant}
            disabled={disabled}
            onChange={(event) => onGrantChange(event.target.checked)}
            className="h-3.5 w-3.5 accent-status-working"
          />
          <span>信任此项目</span>
        </label>
        <div className="mt-1 text-[10px] leading-relaxed text-deck-muted/75">{help}</div>
      </div>
    );
  }

  const note = descriptor.reasonCode === 'policy-disabled'
    ? '当前助手不支持在这里设置项目是否可信，将使用其默认安全设置创建会话。'
    : descriptor.reasonCode === 'unsafe-project-root'
      ? '无法安全地记住对此目录的信任选择，将使用助手自身的安全设置创建会话。'
      : '无法确认此项目是否已受信任。Agent Deck 不会替你授权，将使用助手自身的安全设置创建会话。';
  return (
    <div role="note" className="rounded border border-white/[0.07] bg-white/[0.03] px-2.5 py-2 text-[10px] leading-relaxed text-deck-muted">
      {note}
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
