import { useId, useLayoutEffect, useRef, useState, type JSX } from 'react';

import type { IssueRecord } from '@shared/types';
import type { SessionThinkingChoice } from '@renderer/components/SessionModelFields';
import { useImageAttachments } from '@renderer/hooks/useImageAttachments';
import { errorMessage } from '@renderer/lib/error-message';
import type {
  RemoteSessionCreateInput,
  RemoteSessionSourceView,
} from '@renderer/remote-host/source-types';
import {
  buildRemoteSessionCreateInput,
  remoteControls,
} from '../NewSessionDialog';
import { NewSessionForm } from '../new-session/NewSessionForm';
import { RemoteWorkspaceDirectoryDialog } from '../new-session/RemoteWorkspaceDirectoryDialog';
import { useRemoteSessionCreation } from '../new-session/useRemoteSessionCreation';
import { buildIssueResolutionPrompt } from './issue-resolution-prompt';

interface Props {
  issue: IssueRecord;
  source: RemoteSessionSourceView;
  onClose(): void;
  onResolve(input: RemoteSessionCreateInput): Promise<IssueRecord>;
  onResolved(issue: IssueRecord): void;
}

/** Shared new-session presentation backed only by the Remote Core issue coordinator. */
export function RemoteIssueResolutionDialog({
  issue,
  source,
  onClose,
  onResolve,
  onResolved,
}: Props): JSX.Element {
  const [workingDirectory, setWorkingDirectory] = useState(issue.cwd ?? '.');
  const [prompt, setPrompt] = useState(() => buildIssueResolutionPrompt(issue));
  const [busy, setBusy] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const authoringId = useId();
  const images = useImageAttachments();
  const remote = useRemoteSessionCreation({
    active: true,
    scopeKey: `issue-resolution:${issue.id}`,
    source,
    workingDirectory,
  });
  const previousReadinessIdentity = useRef(remote.readinessIdentity);
  const descriptor = remote.presentationDescriptor;
  const acceptsAttachments = descriptor?.create.attachments.enabled === true;
  const options = remote.presentationOptions;
  const formIdentity = `issue-resolution:${authoringId}:${issue.id}:${remote.readinessIdentity}`;

  useLayoutEffect(() => {
    if (previousReadinessIdentity.current === remote.readinessIdentity) return;
    previousReadinessIdentity.current = remote.readinessIdentity;
    sequence.current += 1;
    inFlight.current = false;
    setBusy(false);
    setDirectoryOpen(false);
    setError(null);
  }, [remote.readinessIdentity]);

  const close = (): void => {
    sequence.current += 1;
    inFlight.current = false;
    setBusy(false);
    setDirectoryOpen(false);
    onClose();
  };

  const submit = async (): Promise<void> => {
    if (inFlight.current) return;
    setError(null);
    if (!prompt.trim() && images.attachments.length === 0) {
      setError('请输入第一条消息或添加图片');
      return;
    }
    if (images.attachments.length > 0 && !acceptsAttachments) {
      setError(descriptor?.create.attachments.disabledReason
        ?? '当前运行时不支持图片输入；图片仍保留，可切换运行时后重试。');
      return;
    }
    inFlight.current = true;
    const requestSequence = ++sequence.current;
    setBusy(true);
    try {
      const input = buildRemoteSessionCreateInput(
        remote,
        workingDirectory,
        prompt,
        images.toIpcInputs(),
      );
      const updated = await onResolve(input);
      if (sequence.current !== requestSequence) return;
      images.clear();
      onResolved(updated);
    } catch (reason) {
      if (sequence.current === requestSequence) setError(errorMessage(reason));
    } finally {
      if (sequence.current === requestSequence) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <>
      <NewSessionForm
        key={formIdentity}
        acceptsAttachments={acceptsAttachments}
        adapterId={remote.presentationAdapterId}
        adapters={remote.adapters.map((adapter) => ({
          value: adapter.adapterId,
          label: adapter.displayName,
          disabled: !adapter.enabled,
          title: adapter.disabledReason ?? undefined,
          description: adapter.disabledReason ?? undefined,
        }))}
        attachmentReason={descriptor?.create.attachments.disabledReason ?? null}
        authoringId={formIdentity}
        busy={busy}
        canCreate={Boolean(
          source.usable && source.capabilities.has('issues') &&
          source.capabilities.has('session-console.create') && remote.descriptor?.create.enabled &&
          remote.ready && remote.adapterId && (prompt.trim() || images.attachments.length > 0),
        )}
        controls={remoteControls(descriptor, options, remote.setOption)}
        createLabel="创建并关联"
        creatingLabel="创建并关联中…"
        directoryHelp={<>目录始终相对于 Remote Workspace；`.` 表示根目录。</>}
        directoryPlaceholder=". 或 repo/subdir"
        error={error ?? remote.error ?? source.error}
        images={images}
        initializing={remote.initializing}
        configurationPending={remote.loading}
        configurationControlsBlocked={remote.loading}
        configurationSubmissionBlocked={remote.loading}
        model={{
          adapterId: remote.presentationAdapterId,
          provider: options.provider ?? '',
          model: options.model ?? '',
          thinking: (options.thinking ?? '') as SessionThinkingChoice,
          providerClosed: true,
          providerOptions: descriptor?.create.options.provider.allowedValues?.map((id) => ({ id })) ?? [],
          thinkingOptions: descriptor?.create.options.thinking.allowedValues?.map((value) => ({
            value: value as SessionThinkingChoice,
            label: value.toUpperCase(),
          })) ?? [],
          disabledReasons: {
            provider: descriptor?.create.options.provider.enabled
              ? null : descriptor?.create.options.provider.disabledReason,
            model: descriptor?.create.options.model.enabled
              ? null : descriptor?.create.options.model.disabledReason,
            thinking: descriptor?.create.options.thinking.enabled
              ? null : descriptor?.create.options.thinking.disabledReason,
          },
          onProviderChange: (value) => remote.setOption('provider', value),
          onModelChange: (value) => remote.setOption('model', value),
          onThinkingChange: (value) => remote.setOption('thinking', value),
        }}
        notice={issue.resolutionSessionId ? (
          <div className="rounded bg-status-waiting/10 px-2 py-1 text-[10px] text-status-waiting">
            该问题已有处理会话；创建成功后，新会话将接替后续处理。
          </div>
        ) : undefined}
        pickingDirectory={false}
        prompt={prompt}
        sourceLabel={`Remote · ${source.profile?.label ?? 'Worker'} · Workspace`}
        title="新建处理会话"
        workingDirectory={workingDirectory}
        onAdapterChange={remote.setAdapterId}
        onBrowseDirectory={() => setDirectoryOpen(true)}
        onClose={close}
        onCreate={() => void submit()}
        onPromptChange={setPrompt}
        onRetryConfiguration={!error && remote.error ? remote.retry : undefined}
        onWorkingDirectoryChange={setWorkingDirectory}
      />
      {directoryOpen && (
        <RemoteWorkspaceDirectoryDialog
          initialDirectory={workingDirectory}
          source={source}
          onClose={() => setDirectoryOpen(false)}
          onSelect={(directory) => {
            setWorkingDirectory(directory);
            setDirectoryOpen(false);
          }}
        />
      )}
    </>
  );
}
