import type { JSX, ReactNode } from 'react';

import type { DeckSelectOption } from '@renderer/components/DeckSelect';
import { DeckSelect } from '@renderer/components/DeckSelect';
import { SessionModelDisclosure } from '@renderer/components/SessionModelDisclosure';
import type { SessionThinkingChoice } from '@renderer/components/SessionModelFields';
import type { UseImageAttachmentsResult } from '@renderer/hooks/useImageAttachments';
import { CloseIcon, FolderOpenIcon, SendIcon } from '../icons';
import { GrokSandboxPicker } from '../GrokSandboxPicker';
import { FirstMessageAuthoring } from './FirstMessageAuthoring';

export interface NewSessionSelectControl {
  label: string;
  options: readonly DeckSelectOption<string>[];
  value: string;
  onChange(value: string): void;
  customGrok?: boolean;
}

export interface NewSessionModelControl {
  adapterId: string;
  model: string;
  provider: string;
  providerClosed: boolean;
  providerOptions?: readonly { id: string; name?: string }[];
  thinking: SessionThinkingChoice;
  thinkingOptions?: readonly DeckSelectOption<SessionThinkingChoice>[];
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
  directoryHelp: ReactNode;
  directoryPlaceholder: string;
  error: string | null;
  images: UseImageAttachmentsResult;
  loading: boolean;
  notice?: ReactNode;
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

export function NewSessionForm(props: Props): JSX.Element {
  const disabled = props.busy || props.loading;
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="no-drag max-h-[85%] w-[340px] overflow-y-auto scrollbar-deck rounded-xl border border-deck-border bg-deck-bg-strong p-4 shadow-2xl">
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-medium">{props.title ?? '新建会话'}</h2>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="关闭新建会话"
            className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </header>

        {props.adapters.length === 0 ? (
          <div className={props.error ? 'text-[11px] text-status-waiting' : 'text-[11px] text-deck-muted'}>
            {props.error ?? (props.loading ? '正在读取运行时配置…' : '没有可用的运行时')}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
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

            <SessionModelDisclosure
              adapterId={props.model.adapterId}
              provider={props.model.provider}
              model={props.model.model}
              thinking={props.model.thinking}
              disabled={disabled}
              providerOptions={props.model.providerOptions}
              providerClosed={props.model.providerClosed}
              thinkingOptions={props.model.thinkingOptions}
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
              <div className="text-[10px] leading-relaxed text-deck-muted/70">
                {props.directoryHelp}
              </div>
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
                {control.customGrok ? (
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
                className="rounded px-3 py-1 text-[11px] text-deck-muted hover:bg-white/5"
              >
                取消
              </button>
              <button
                type="button"
                onClick={props.onCreate}
                disabled={!props.canCreate || disabled}
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
