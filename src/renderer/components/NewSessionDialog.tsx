import { useEffect, useId, useRef, useState, type JSX } from 'react';

import type { DeckSelectOption } from '@renderer/components/DeckSelect';
import type { SessionThinkingChoice } from '@renderer/components/SessionModelFields';
import { useImageAttachments } from '@renderer/hooks/useImageAttachments';
import { getLastAdapter, setLastAdapter } from '@renderer/hooks/useLastSessionDefaults';
import { useSessionCreationOptions } from '@renderer/hooks/useSessionCreationOptions';
import { errorMessage } from '@renderer/lib/error-message';
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';
import { NewSessionForm } from './new-session/NewSessionForm';
import { RemoteWorkspaceDirectoryDialog } from './new-session/RemoteWorkspaceDirectoryDialog';
import {
  localControls,
  remoteControls,
  submitLocalSession,
  submitRemoteSession,
  type LocalSessionAdapterInfo,
} from './new-session/session-dialog-actions';
import { useRemoteSessionCreation } from './new-session/useRemoteSessionCreation';

export {
  buildRemoteSessionCreateInput,
  localControls,
  remoteControls,
} from './new-session/session-dialog-actions';
export type { LocalSessionAdapterInfo } from './new-session/session-dialog-actions';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
  remoteSource?: RemoteSessionSourceView | null;
}

export function NewSessionDialog({
  open,
  onClose,
  onCreated,
  remoteSource = null,
}: Props): JSX.Element | null {
  const remoteMode = remoteSource !== null;
  const [localAdapters, setLocalAdapters] = useState<LocalSessionAdapterInfo[]>([]);
  const [localAdapterId, setLocalAdapterId] = useState<string>(() => getLastAdapter());
  const [workingDirectory, setWorkingDirectory] = useState(remoteMode ? '.' : '');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const [remoteDirectoryOpen, setRemoteDirectoryOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const localOptions = useSessionCreationOptions({
    adapterId: localAdapterId,
    cwd: workingDirectory,
    active: open && !remoteMode,
  });
  const remote = useRemoteSessionCreation({
    active: open && remoteMode,
    source: remoteSource,
    workingDirectory,
  });
  const pickingDirectoryRef = useRef(false);
  const openRef = useRef(open);
  const previousOpenRef = useRef(open);
  const previousSourceIdentity = useRef(remoteSource?.identity ?? 'local');
  const dialogEpochRef = useRef(0);
  const createSequenceRef = useRef(0);
  const createInFlightRef = useRef(false);
  const authoringInstanceId = useId();
  const images = useImageAttachments();
  const sourceIdentity = remoteSource?.identity ?? 'local';

  openRef.current = open;
  if (previousOpenRef.current !== open) {
    previousOpenRef.current = open;
    dialogEpochRef.current += 1;
    createSequenceRef.current += 1;
    createInFlightRef.current = false;
  }

  useEffect(() => {
    if (!open) {
      createInFlightRef.current = false;
      pickingDirectoryRef.current = false;
      setBusy(false);
      setPickingDirectory(false);
      setRemoteDirectoryOpen(false);
    }
  }, [open]);

  useEffect(() => {
    const identity = sourceIdentity;
    if (previousSourceIdentity.current === identity) return;
    previousSourceIdentity.current = identity;
    dialogEpochRef.current += 1;
    createSequenceRef.current += 1;
    createInFlightRef.current = false;
    setWorkingDirectory(remoteMode ? '.' : '');
    setPrompt('');
    setError(null);
    setRemoteDirectoryOpen(false);
    images.clear();
  }, [images.clear, remoteMode, sourceIdentity]);

  useEffect(() => {
    if (!open || remoteMode) return;
    let cancelled = false;
    setError(null);
    void window.api.listAdapters().then((rows) => {
      if (cancelled) return;
      const usable = rows.filter((adapter) => adapter.capabilities.canCreateSession);
      setLocalAdapters(usable);
      if (usable.length > 0) {
        setLocalAdapterId((current) => {
          const next = usable.find((adapter) => adapter.id === current)?.id
            ?? usable.find((adapter) => adapter.id === getLastAdapter())?.id
            ?? usable[0]!.id;
          setLastAdapter(next);
          return next;
        });
      }
    }).catch((reason: unknown) => {
      if (!cancelled) setError(`运行时读取失败：${errorMessage(reason)}`);
    });
    return () => { cancelled = true; };
  }, [open, remoteMode]);

  if (!open) return null;

  const adapterId = remoteMode ? remote.adapterId : localAdapterId;
  const selectedLocalAdapter = localAdapters.find((adapter) => adapter.id === localAdapterId);
  const descriptor = remote.descriptor;
  const createOptions = remoteMode ? remote.options : null;
  const provider = remoteMode ? createOptions?.provider ?? '' : localOptions.provider;
  const model = remoteMode ? createOptions?.model ?? '' : localOptions.model;
  const thinking = (
    remoteMode ? createOptions?.thinking ?? '' : localOptions.thinking
  ) as SessionThinkingChoice;
  const adapters: DeckSelectOption<string>[] = remoteMode
    ? remote.adapters.map((adapter) => ({
        value: adapter.adapterId,
        label: adapter.displayName,
        disabled: !adapter.enabled,
        title: adapter.disabledReason ?? undefined,
        description: adapter.disabledReason ?? undefined,
      }))
    : localAdapters.map((adapter) => ({ value: adapter.id, label: adapter.displayName }));
  const controls = remoteMode
    ? remoteControls(descriptor, remote.options, remote.setOption)
    : localControls(localAdapterId, selectedLocalAdapter, localOptions);
  const acceptsAttachments = remoteMode
    ? descriptor?.create.attachments.enabled === true
    : selectedLocalAdapter?.capabilities.canAcceptAttachments === true;
  const combinedError = error ?? remote.error ?? remoteSource?.error ?? null;

  const browse = async (): Promise<void> => {
    if (remoteMode || busy || pickingDirectoryRef.current) return;
    const epoch = dialogEpochRef.current;
    pickingDirectoryRef.current = true;
    setPickingDirectory(true);
    try {
      const result = await window.api.chooseDirectory(
        workingDirectory.trim() ? workingDirectory : undefined,
      );
      if (result && openRef.current && epoch === dialogEpochRef.current) {
        setWorkingDirectory(result);
      }
    } catch (reason) {
      if (openRef.current && epoch === dialogEpochRef.current) {
        setError(`目录选择失败：${errorMessage(reason)}`);
      }
    } finally {
      if (epoch === dialogEpochRef.current) {
        pickingDirectoryRef.current = false;
        setPickingDirectory(false);
      }
    }
  };

  const submit = async (): Promise<void> => {
    if (createInFlightRef.current) return;
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
    createInFlightRef.current = true;
    const requestSequence = ++createSequenceRef.current;
    const dialogEpoch = dialogEpochRef.current;
    setBusy(true);
    try {
      const id = remoteMode
        ? await submitRemoteSession(
            remoteSource,
            remote,
            workingDirectory,
            prompt,
            images.toIpcInputs(),
          )
        : await submitLocalSession(
            localAdapterId,
            selectedLocalAdapter,
            localOptions,
            workingDirectory,
            prompt,
            images.toIpcInputs(),
          );
      if (requestSequence !== createSequenceRef.current ||
          dialogEpoch !== dialogEpochRef.current || !openRef.current) return;
      onCreated(id);
      setPrompt('');
      images.clear();
      dialogEpochRef.current += 1;
      createSequenceRef.current += 1;
      createInFlightRef.current = false;
      onClose();
    } catch (reason) {
      if (requestSequence === createSequenceRef.current &&
          dialogEpoch === dialogEpochRef.current && openRef.current) {
        setError(errorMessage(reason));
      }
    } finally {
      if (requestSequence === createSequenceRef.current && dialogEpoch === dialogEpochRef.current) {
        createInFlightRef.current = false;
        setBusy(false);
      }
    }
  };

  const close = (): void => {
    dialogEpochRef.current += 1;
    createSequenceRef.current += 1;
    createInFlightRef.current = false;
    pickingDirectoryRef.current = false;
    setBusy(false);
    setPickingDirectory(false);
    setRemoteDirectoryOpen(false);
    onClose();
  };

  return (
    <>
      <NewSessionForm
      acceptsAttachments={acceptsAttachments}
      adapterId={adapterId}
      adapters={adapters}
      attachmentReason={descriptor?.create.attachments.disabledReason ?? null}
      authoringId={`new-session:${authoringInstanceId}:${remoteSource?.identity ?? 'local'}`}
      busy={busy}
      canCreate={Boolean(
        adapterId && (prompt.trim() || images.attachments.length > 0) &&
        (remoteMode
          ? remoteSource?.usable && descriptor?.create.enabled && !remote.loading
          : selectedLocalAdapter),
      )}
      controls={controls}
      directoryHelp={remoteMode
        ? <>目录始终相对于 Remote Workspace；`.` 表示根目录，绝对路径和 `..` 会被拒绝。</>
        : <>留空时使用当前用户主目录。</>}
      directoryPlaceholder={remoteMode ? '. 或 repo/subdir' : '留空则使用主目录（~）'}
      error={combinedError}
      images={images}
      loading={remote.loading}
      modelLoading={remoteMode ? remote.loading : localOptions.defaultsLoading}
      model={{
        adapterId,
        provider,
        model,
        thinking,
        providerClosed: remoteMode,
        providerOptions: remoteMode
          ? descriptor?.create.options.provider.allowedValues?.map((id) => ({ id })) ?? []
          : undefined,
        thinkingOptions: remoteMode
          ? descriptor?.create.options.thinking.allowedValues?.map((value) => ({
              value: value as SessionThinkingChoice,
              label: value.toUpperCase(),
            })) ?? []
          : undefined,
        disabledReasons: remoteMode ? {
          provider: descriptor?.create.options.provider.enabled
            ? null : descriptor?.create.options.provider.disabledReason,
          model: descriptor?.create.options.model.enabled
            ? null : descriptor?.create.options.model.disabledReason,
          thinking: descriptor?.create.options.thinking.enabled
            ? null : descriptor?.create.options.thinking.disabledReason,
        } : undefined,
        onProviderChange: (value) => remoteMode
          ? remote.setOption('provider', value) : localOptions.setProvider(value),
        onModelChange: (value) => remoteMode
          ? remote.setOption('model', value) : localOptions.setModel(value),
        onThinkingChange: (value) => remoteMode
          ? remote.setOption('thinking', value) : localOptions.setThinking(value),
      }}
      pickingDirectory={pickingDirectory}
      prompt={prompt}
      sourceLabel={remoteMode
        ? `Remote · ${remoteSource?.profile?.label ?? 'Worker'} · Workspace`
        : 'Local · 本机'}
      workingDirectory={workingDirectory}
      onAdapterChange={(value) => {
        if (remoteMode) remote.setAdapterId(value);
        else { setLocalAdapterId(value); setLastAdapter(value); }
      }}
      onBrowseDirectory={remoteMode
        ? () => setRemoteDirectoryOpen(true)
        : () => void browse()}
      onClose={close}
      onCreate={() => void submit()}
      onPromptChange={setPrompt}
      onWorkingDirectoryChange={setWorkingDirectory}
      />
      {remoteDirectoryOpen && remoteSource && (
        <RemoteWorkspaceDirectoryDialog
          initialDirectory={workingDirectory}
          source={remoteSource}
          onClose={() => setRemoteDirectoryOpen(false)}
          onSelect={(directory) => {
            setWorkingDirectory(directory);
            setRemoteDirectoryOpen(false);
          }}
        />
      )}
    </>
  );
}
