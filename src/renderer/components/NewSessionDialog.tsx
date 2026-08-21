import { useEffect, useId, useLayoutEffect, useRef, useState, type JSX } from 'react';

import type { DeckSelectOption } from '@renderer/components/DeckSelect';
import type { SessionThinkingChoice } from '@renderer/components/SessionModelFields';
import { useImageAttachments } from '@renderer/hooks/useImageAttachments';
import { getLastAdapter, setLastAdapter } from '@renderer/hooks/useLastSessionDefaults';
import { useSessionCreationOptions } from '@renderer/hooks/useSessionCreationOptions';
import { useSessionCreationProjection } from '@renderer/hooks/useSessionCreationProjection';
import { errorMessage } from '@renderer/lib/error-message';
import log from '@renderer/utils/logger';
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

const logger = log.scope('new-session');

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
  const [localAdaptersSettledEpoch, setLocalAdaptersSettledEpoch] = useState(-1);
  const [localAdaptersFailedEpoch, setLocalAdaptersFailedEpoch] = useState(-1);
  const [localAdapterId, setLocalAdapterId] = useState<string>(() => getLastAdapter());
  const [workingDirectory, setWorkingDirectory] = useState(remoteMode ? '.' : '');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const [remoteDirectoryOpen, setRemoteDirectoryOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickingDirectoryRef = useRef(false);
  const openRef = useRef(open);
  const previousOpenRef = useRef(open);
  const previousSourceIdentity = useRef(remoteSource?.identity ?? 'local');
  const dialogEpochRef = useRef(0);
  const openCycleRef = useRef(0);
  const createSequenceRef = useRef(0);
  const createInFlightRef = useRef(false);
  const authoringInstanceId = useId();
  const images = useImageAttachments();
  const sourceIdentity = remoteSource?.identity ?? 'local';

  openRef.current = open;
  if (previousOpenRef.current !== open) {
    previousOpenRef.current = open;
    dialogEpochRef.current += 1;
    openCycleRef.current += 1;
    createSequenceRef.current += 1;
    createInFlightRef.current = false;
  }
  const authoringScope = `new-session:${openCycleRef.current}`;
  const localOptions = useSessionCreationOptions({
    adapterId: localAdapterId,
    cwd: workingDirectory,
    active: open && !remoteMode,
    scopeKey: authoringScope,
  });
  const selectedLocalAdapter = localAdapters.find((adapter) => adapter.id === localAdapterId);
  const localPresentation = useSessionCreationProjection({
    scopeKey: authoringScope,
    adapterId: localAdapterId,
    adapter: selectedLocalAdapter,
    options: localOptions,
  });
  const remote = useRemoteSessionCreation({
    active: open && remoteMode,
    scopeKey: authoringScope,
    source: remoteSource,
    workingDirectory,
  });
  const previousRemoteReadinessIdentity = useRef(remote.readinessIdentity);

  useEffect(() => {
    if (!open) {
      createInFlightRef.current = false;
      pickingDirectoryRef.current = false;
      setBusy(false);
      setPickingDirectory(false);
      setRemoteDirectoryOpen(false);
    }
  }, [open]);

  useLayoutEffect(() => {
    if (!remoteMode) {
      previousRemoteReadinessIdentity.current = remote.readinessIdentity;
      return;
    }
    if (previousRemoteReadinessIdentity.current === remote.readinessIdentity) return;
    previousRemoteReadinessIdentity.current = remote.readinessIdentity;
    dialogEpochRef.current += 1;
    createSequenceRef.current += 1;
    createInFlightRef.current = false;
    pickingDirectoryRef.current = false;
    setBusy(false);
    setPickingDirectory(false);
    setRemoteDirectoryOpen(false);
    setError(null);
  }, [remote.readinessIdentity, remoteMode]);

  useLayoutEffect(() => {
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
    const epoch = dialogEpochRef.current;
    setError(null);
    setLocalAdapters([]);
    setLocalAdaptersFailedEpoch(-1);
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
      if (!cancelled) {
        setLocalAdapters([]);
        setLocalAdaptersFailedEpoch(epoch);
        setError(`运行时读取失败：${errorMessage(reason)}`);
      }
    }).finally(() => {
      if (!cancelled) setLocalAdaptersSettledEpoch(epoch);
    });
    return () => { cancelled = true; };
  }, [open, remoteMode]);

  if (!open) return null;

  const adapterId = remoteMode ? remote.presentationAdapterId : localAdapterId;
  const configurationAdapterId = remoteMode
    ? remote.presentationAdapterId
    : localPresentation.adapterId;
  const presentedLocalAdapter = localPresentation.adapter;
  const presentedLocalOptions = localPresentation.options;
  const descriptor = remote.presentationDescriptor;
  const createOptions = remoteMode ? remote.presentationOptions : null;
  const provider = remoteMode ? createOptions?.provider ?? '' : presentedLocalOptions.provider;
  const model = remoteMode ? createOptions?.model ?? '' : presentedLocalOptions.model;
  const thinking = (
    remoteMode ? createOptions?.thinking ?? '' : presentedLocalOptions.thinking
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
    : localControls(
        localPresentation.adapterId,
        presentedLocalAdapter,
        presentedLocalOptions,
      );
  const acceptsAttachments = remoteMode
    ? descriptor?.create.attachments.enabled === true
    : presentedLocalAdapter?.capabilities.canAcceptAttachments === true;
  const combinedError = error ?? remote.error ?? remoteSource?.error ?? null;
  const formIdentity = remoteMode
    ? `new-session:${authoringInstanceId}:${remote.readinessIdentity}`
    : `new-session:${authoringInstanceId}:local`;
  const initializing = remoteMode
    ? remote.initializing
    : localAdaptersSettledEpoch !== dialogEpochRef.current || Boolean(
        localAdaptersFailedEpoch !== dialogEpochRef.current &&
        localAdapters.length > 0 &&
        localOptions.configurationLoading,
      );

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
    const createRequestId = window.crypto.randomUUID();
    setBusy(true);
    logger.info('[new-session] create requested', {
      event: 'new_session_create',
      phase: 'renderer_requested',
      requestId: createRequestId,
      adapterId: remoteMode ? remote.adapterId : localAdapterId,
      remote: remoteMode,
    });
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
            createRequestId,
          );
      if (requestSequence !== createSequenceRef.current ||
          dialogEpoch !== dialogEpochRef.current || !openRef.current) return;
      onCreated(id);
      logger.info('[new-session] create accepted', {
        event: 'new_session_create',
        phase: 'renderer_accepted',
        requestId: createRequestId,
        adapterId: remoteMode ? remote.adapterId : localAdapterId,
      });
      setPrompt('');
      images.clear();
      dialogEpochRef.current += 1;
      createSequenceRef.current += 1;
      createInFlightRef.current = false;
      onClose();
    } catch (reason) {
      logger.warn('[new-session] create failed', {
        event: 'new_session_create',
        phase: 'renderer_failed',
        requestId: createRequestId,
        adapterId: remoteMode ? remote.adapterId : localAdapterId,
        error: errorMessage(reason),
      });
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
        key={formIdentity}
        acceptsAttachments={acceptsAttachments}
        adapterId={adapterId}
        adapters={adapters}
        attachmentReason={descriptor?.create.attachments.disabledReason ?? null}
        authoringId={formIdentity}
        busy={busy}
        canCreate={Boolean(
          adapterId && (prompt.trim() || images.attachments.length > 0) &&
          (remoteMode
            ? remoteSource?.usable && remote.descriptor?.create.enabled && remote.ready
            : selectedLocalAdapter),
        )}
        controls={controls}
        directoryHelp={remoteMode
          ? <>目录始终相对于远端工作区；`.` 表示根目录，不能使用绝对路径或 `..`。</>
          : null}
        directoryPlaceholder={remoteMode ? '. 或 repo/subdir' : '留空则使用主目录（~）'}
        error={combinedError}
        images={images}
        initializing={initializing}
        configurationPending={remoteMode ? remote.loading : localOptions.configurationLoading}
        configurationControlsBlocked={
          (remoteMode && (
            remote.initializing ||
            (remote.loading && remote.presentationAdapterId !== remote.adapterId)
          )) || (!remoteMode && localPresentation.deferred)
        }
        configurationSubmissionBlocked={remoteMode
          ? remote.loading
          : localOptions.configurationLoading}
        model={{
          adapterId: configurationAdapterId,
          provider,
          model,
          thinking,
          providerOptions: remoteMode
            ? descriptor?.create.options.provider.allowedValues?.map((id) => ({ id })) ?? []
            : presentedLocalOptions.providerOptions,
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
            ? remote.setOption('provider', value) : presentedLocalOptions.setProvider(value),
          onModelChange: (value) => remoteMode
            ? remote.setOption('model', value) : presentedLocalOptions.setModel(value),
          onThinkingChange: (value) => remoteMode
            ? remote.setOption('thinking', value) : presentedLocalOptions.setThinking(value),
        }}
        pickingDirectory={pickingDirectory}
        prompt={prompt}
        sourceLabel={remoteMode
          ? `远端 · ${remoteSource?.profile?.label ?? '远端主机'} · 工作区`
          : '本机'}
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
        onRetryConfiguration={remoteMode && !error && remote.error
          ? remote.retry
          : undefined}
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
