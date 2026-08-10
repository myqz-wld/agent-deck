import { useEffect, useId, useRef, useState, type JSX } from 'react';

import type { SessionConsoleCreateOptionKey } from '@contracts/index';
import { parseSessionConsoleAttachments } from '@contracts/index';
import type { DeckSelectOption } from '@renderer/components/DeckSelect';
import type { SessionThinkingChoice } from '@renderer/components/SessionModelFields';
import { useImageAttachments } from '@renderer/hooks/useImageAttachments';
import { getLastAdapter, setLastAdapter } from '@renderer/hooks/useLastSessionDefaults';
import { useSessionCreationOptions } from '@renderer/hooks/useSessionCreationOptions';
import {
  CLAUDE_SANDBOX_OPTIONS,
  CODEX_APPROVAL_POLICY_OPTIONS,
  CODEX_SANDBOX_OPTIONS,
  PERMISSION_OPTIONS,
} from '@renderer/lib/sandbox-options';
import { adapterSessionModeOptions } from '@renderer/lib/adapter-session-modes';
import { errorMessage } from '@renderer/lib/error-message';
import type {
  RemoteSessionCreateInput,
  RemoteSessionSourceView,
} from '@renderer/remote-host/source-types';
import type { AdapterSessionMode } from '@shared/types';
import {
  NewSessionForm,
  type NewSessionSelectControl,
} from './new-session/NewSessionForm';
import { RemoteWorkspaceDirectoryDialog } from './new-session/RemoteWorkspaceDirectoryDialog';
import {
  closedSessionOptions,
  remoteSandboxOptions,
} from './new-session/remote-sandbox-options';
import {
  localSessionOptionKeys,
  remoteSessionOptionKeys,
  sessionOptionLabel,
} from './new-session/session-option-catalog';
import { useRemoteSessionCreation } from './new-session/useRemoteSessionCreation';

interface AdapterInfo {
  id: string;
  displayName: string;
  capabilities: {
    canCreateSession?: boolean;
    canSetPermissionMode?: boolean;
    canSetSessionMode?: boolean;
    canAcceptAttachments?: boolean;
  };
  sessionModes: AdapterSessionMode[];
}

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
  const [localAdapters, setLocalAdapters] = useState<AdapterInfo[]>([]);
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
        ? await submitRemote(
            remoteSource,
            remote,
            workingDirectory,
            prompt,
            images.toIpcInputs(),
          )
        : await submitLocal(
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
        onProviderChange: (value) => remoteMode
          ? remote.setOption('provider', value) : localOptions.setProvider(value),
        onModelChange: (value) => remoteMode
          ? remote.setOption('model', value) : localOptions.setModel(value),
        onThinkingChange: (value) => remoteMode
          ? remote.setOption('thinking', value) : localOptions.setThinking(value),
      }}
      pickingDirectory={pickingDirectory}
      prompt={prompt}
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

export function remoteControls(
  descriptor: ReturnType<typeof useRemoteSessionCreation>['descriptor'],
  values: ReturnType<typeof useRemoteSessionCreation>['options'],
  setOption: (key: SessionConsoleCreateOptionKey, value: string) => void,
): NewSessionSelectControl[] {
  if (!descriptor) return [];
  const result: NewSessionSelectControl[] = [];
  const add = (key: SessionConsoleCreateOptionKey): void => {
    const schema = descriptor.create.options[key];
    const value = values[key];
    if (!schema.enabled || value === null || !schema.allowedValues) return;
    result.push({ label: sessionOptionLabel(key), value, options: closedSessionOptions(schema.allowedValues),
      onChange: (next) => setOption(key, next) });
  };
  for (const key of remoteSessionOptionKeys(descriptor)) {
    if (key !== descriptor.create.sandbox.optionKey) {
      add(key);
      continue;
    }
    const value = values[key];
    if (value !== null) {
      result.push({
        label: sessionOptionLabel(key),
        value,
        options: remoteSandboxOptions(descriptor.create.sandbox.choices, key),
        onChange: (next) => setOption(key, next),
      });
    }
  }
  return result;
}

function localControls(
  adapterId: string,
  adapter: AdapterInfo | undefined,
  options: ReturnType<typeof useSessionCreationOptions>,
): NewSessionSelectControl[] {
  const result: NewSessionSelectControl[] = [];
  const keys = localSessionOptionKeys(adapterId, {
    canSetPermissionMode: adapter?.capabilities?.canSetPermissionMode === true,
    canSetSessionMode: adapter?.capabilities?.canSetSessionMode === true,
    hasSessionModes: (adapter?.sessionModes?.length ?? 0) > 0,
  });
  for (const key of keys) {
    if (key === 'permissionMode') {
      result.push({ label: sessionOptionLabel(key), value: options.permissionMode,
        options: PERMISSION_OPTIONS, onChange: (value) => options.setPermissionMode(
          value as Parameters<typeof options.setPermissionMode>[0]) });
    } else if (key === 'sessionMode') {
      result.push({ label: sessionOptionLabel(key), value: options.sessionMode,
        options: adapterSessionModeOptions(adapter?.sessionModes ?? []), onChange: (value) =>
          options.setSessionMode(value as Parameters<typeof options.setSessionMode>[0]) });
    } else if (key === 'approvalPolicy') {
      result.push({ label: sessionOptionLabel(key), value: options.approvalPolicy,
        options: CODEX_APPROVAL_POLICY_OPTIONS, onChange: (value) =>
          options.setApprovalPolicy(value as Parameters<typeof options.setApprovalPolicy>[0]) });
    } else if (key === 'codexSandbox') {
      result.push({ label: sessionOptionLabel(key), value: options.codexSandbox,
        options: CODEX_SANDBOX_OPTIONS, onChange: (value) =>
          options.setCodexSandbox(value as Parameters<typeof options.setCodexSandbox>[0]) });
    } else if (key === 'claudeCodeSandbox') {
      result.push({ label: sessionOptionLabel(key), value: options.claudeCodeSandbox,
        options: CLAUDE_SANDBOX_OPTIONS, onChange: (value) =>
          options.setClaudeCodeSandbox(value as Parameters<typeof options.setClaudeCodeSandbox>[0]) });
    } else if (key === 'grokSandbox') {
      result.push({ label: sessionOptionLabel(key), value: options.grokSandbox,
        options: [], customGrok: true, onChange: options.setGrokSandbox });
    }
  }
  return result;
}

async function submitRemote(
  source: RemoteSessionSourceView | null,
  remote: ReturnType<typeof useRemoteSessionCreation>,
  workingDirectory: string,
  prompt: string,
  attachments: ReturnType<ReturnType<typeof useImageAttachments>['toIpcInputs']>,
): Promise<string> {
  if (!source || !remote.descriptor) throw new Error('远程运行时配置尚未就绪。');
  return source.createSession(buildRemoteSessionCreateInput(
    remote,
    workingDirectory,
    prompt,
    attachments,
  ));
}

export function buildRemoteSessionCreateInput(
  remote: ReturnType<typeof useRemoteSessionCreation>,
  workingDirectory: string,
  prompt: string,
  attachments: ReturnType<ReturnType<typeof useImageAttachments>['toIpcInputs']>,
): RemoteSessionCreateInput {
  if (!remote.descriptor) throw new Error('远程运行时配置尚未就绪。');
  const validatedAttachments = parseSessionConsoleAttachments(attachments);
  const policy = remote.descriptor.create.attachments;
  const totalBytes = validatedAttachments.reduce((total, attachment) => total + attachment.bytes, 0);
  if (
    validatedAttachments.length > policy.maxCount ||
    validatedAttachments.some((attachment) =>
      attachment.bytes > policy.maxBytesEach || !policy.mimeTypes.includes(attachment.mime)) ||
    totalBytes > policy.maxBytesTotal
  ) {
    throw new Error('图片超过当前 Remote Core 协商的传输限制；图片仍保留，可移除后重试。');
  }
  return {
    adapterId: remote.adapterId,
    attachments: validatedAttachments,
    capabilityRevision: remote.descriptor.capabilityRevision,
    initialMessage: prompt.trim(),
    options: remote.options,
    workingDirectory: workingDirectory.trim() || '.',
  };
}

async function submitLocal(
  adapterId: string,
  adapter: AdapterInfo | undefined,
  options: ReturnType<typeof useSessionCreationOptions>,
  cwd: string,
  prompt: string,
  attachments: ReturnType<ReturnType<typeof useImageAttachments>['toIpcInputs']>,
): Promise<string> {
  return window.api.createAdapterSession(adapterId, {
    cwd: cwd.trim(),
    prompt: prompt.trim() || undefined,
    permissionMode: adapter?.capabilities.canSetPermissionMode ? options.permissionMode : undefined,
    sessionMode: adapter?.capabilities.canSetSessionMode ? options.sessionMode : undefined,
    approvalPolicy: adapterId === 'codex-cli' ? options.approvalPolicy : undefined,
    codexSandbox: adapterId === 'codex-cli' ? options.codexSandbox : undefined,
    claudeCodeSandbox: adapterId === 'claude-code' ? options.claudeCodeSandbox : undefined,
    grokSandbox: adapterId === 'grok-build' ? options.grokSandbox.trim() : undefined,
    ...((adapterId === 'claude-code' || adapterId === 'codex-cli') && options.provider.trim()
      ? { provider: options.provider.trim() } : {}),
    ...(options.model.trim() ? { model: options.model.trim() } : {}),
    ...(options.thinking ? { thinking: options.thinking } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  });
}
