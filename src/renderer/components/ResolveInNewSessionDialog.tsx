import { useEffect, useId, useRef, useState, type JSX } from 'react';

import type { SessionThinkingChoice } from '@renderer/components/SessionModelFields';
import { useImageAttachments } from '@renderer/hooks/useImageAttachments';
import { getLastAdapter, setLastAdapter } from '@renderer/hooks/useLastSessionDefaults';
import { useSessionCreationOptions } from '@renderer/hooks/useSessionCreationOptions';
import { errorMessage } from '@renderer/lib/error-message';
import type { IssueRecord } from '@shared/types';
import {
  localControls,
  type LocalSessionAdapterInfo,
} from './NewSessionDialog';
import { buildIssueResolutionPrompt } from './issues/issue-resolution-prompt';
import { NewSessionForm } from './new-session/NewSessionForm';

interface Props {
  issue: IssueRecord;
  onClose(): void;
  onResolved(updated: IssueRecord): void;
}

const INCOMPLETE_ROLLBACK_CODE = 'ISSUE_RESOLUTION_ROLLBACK_INCOMPLETE';

/** Local coordinator with the same presentation and attachment behavior as Remote resolution. */
export function ResolveInNewSessionDialog({ issue, onClose, onResolved }: Props): JSX.Element {
  const [adapters, setAdapters] = useState<LocalSessionAdapterInfo[]>([]);
  const [adaptersSettled, setAdaptersSettled] = useState(false);
  const [adapterId, setAdapterId] = useState<string>(() => getLastAdapter());
  const [workingDirectory, setWorkingDirectory] = useState(issue.cwd ?? '');
  const [prompt, setPrompt] = useState(() => buildIssueResolutionPrompt(issue));
  const [busy, setBusy] = useState(false);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rollbackBlocked, setRollbackBlocked] = useState(false);
  const sequenceRef = useRef(0);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const authoringId = useId();
  const images = useImageAttachments();
  const options = useSessionCreationOptions({
    adapterId,
    cwd: workingDirectory,
    scopeKey: `issue-resolution:${issue.id}`,
  });

  useEffect(() => {
    let cancelled = false;
    mountedRef.current = true;
    void window.api.listAdapters().then((rows) => {
      if (cancelled) return;
      const usable = rows.filter((adapter) => adapter.capabilities.canCreateSession);
      setAdapters(usable);
      if (usable.length === 0) return;
      setAdapterId((current) => {
        const next = usable.find((adapter) => adapter.id === current)?.id
          ?? usable.find((adapter) => adapter.id === getLastAdapter())?.id
          ?? usable[0]!.id;
        setLastAdapter(next);
        return next;
      });
    }).catch(() => {
      if (!cancelled) setError('无法读取运行时列表，请稍后重试。');
    }).finally(() => {
      if (!cancelled) setAdaptersSettled(true);
    });
    return () => {
      cancelled = true;
      mountedRef.current = false;
      sequenceRef.current += 1;
      inFlightRef.current = false;
    };
  }, []);

  const selectedAdapter = adapters.find((adapter) => adapter.id === adapterId);
  const acceptsAttachments = selectedAdapter?.capabilities.canAcceptAttachments === true;

  const browse = async (): Promise<void> => {
    if (busy || pickingDirectory) return;
    const sequence = sequenceRef.current;
    setPickingDirectory(true);
    try {
      const result = await window.api.chooseDirectory(
        workingDirectory.trim() ? workingDirectory : undefined,
      );
      if (mountedRef.current && sequence === sequenceRef.current && result) {
        setWorkingDirectory(result);
      }
    } catch {
      if (mountedRef.current && sequence === sequenceRef.current) {
        setError('目录选择失败，请稍后重试。');
      }
    } finally {
      if (mountedRef.current && sequence === sequenceRef.current) setPickingDirectory(false);
    }
  };

  const submit = async (): Promise<void> => {
    if (inFlightRef.current || rollbackBlocked) return;
    setError(null);
    if (!prompt.trim() && images.attachments.length === 0) {
      setError('请输入第一条消息或添加图片');
      return;
    }
    if (images.attachments.length > 0 && !acceptsAttachments) {
      setError('当前运行时不支持图片输入；图片仍保留，可切换运行时后重试。');
      return;
    }
    inFlightRef.current = true;
    const sequence = ++sequenceRef.current;
    setBusy(true);
    try {
      const result = await window.api.issuesResolveInNewSession({
        issueId: issue.id,
        adapter: adapterId,
        cwd: workingDirectory.trim() || undefined,
        prompt,
        attachments: images.toIpcInputs(),
        ...(selectedAdapter?.capabilities.canSetPermissionMode
          ? { permissionMode: options.permissionMode } : {}),
        ...(selectedAdapter?.capabilities.canSetSessionMode
          ? { sessionMode: options.sessionMode } : {}),
        ...(adapterId === 'codex-cli'
          ? { approvalPolicy: options.approvalPolicy, codexSandbox: options.codexSandbox } : {}),
        ...(adapterId === 'claude-code'
          ? { claudeCodeSandbox: options.claudeCodeSandbox } : {}),
        ...(adapterId === 'grok-build' ? { grokSandbox: options.grokSandbox.trim() } : {}),
        ...((adapterId === 'claude-code' || adapterId === 'codex-cli') && options.provider.trim()
          ? { provider: options.provider.trim() } : {}),
        ...(options.model.trim() ? { model: options.model.trim() } : {}),
        ...(options.thinking ? { thinking: options.thinking } : {}),
      });
      if (!mountedRef.current || sequence !== sequenceRef.current) return;
      images.clear();
      onResolved(result.issue);
    } catch (reason) {
      if (!mountedRef.current || sequence !== sequenceRef.current) return;
      const message = errorMessage(reason);
      setError(message);
      if (message.includes(INCOMPLETE_ROLLBACK_CODE)) setRollbackBlocked(true);
    } finally {
      if (mountedRef.current && sequence === sequenceRef.current) {
        inFlightRef.current = false;
        setBusy(false);
      }
    }
  };

  const close = (): void => {
    if (busy) return;
    sequenceRef.current += 1;
    inFlightRef.current = false;
    onClose();
  };

  return (
    <NewSessionForm
      key={`issue-resolution:${authoringId}:${issue.id}`}
      acceptsAttachments={acceptsAttachments}
      adapterId={adapterId}
      adapters={adapters.map((adapter) => ({ value: adapter.id, label: adapter.displayName }))}
      attachmentReason={acceptsAttachments ? null : '当前运行时不支持图片输入。'}
      authoringId={`issue-resolution:${authoringId}:${issue.id}`}
      busy={busy}
      canCreate={Boolean(
        selectedAdapter && !rollbackBlocked && (prompt.trim() || images.attachments.length > 0),
      )}
      controls={localControls(adapterId, selectedAdapter, options)}
      createLabel="新建会话"
      creatingLabel="创建中…"
      directoryHelp={<>留空时沿用问题目录；问题没有目录时使用当前用户主目录。</>}
      directoryPlaceholder="留空则沿用问题目录或主目录"
      error={error}
      images={images}
      initializing={!adaptersSettled || (adapters.length > 0 && options.configurationLoading)}
      configurationPending={options.configurationLoading}
      configurationSubmissionBlocked={options.configurationLoading}
      model={{
        adapterId,
        provider: options.provider,
        model: options.model,
        thinking: options.thinking as SessionThinkingChoice,
        providerOptions: options.providerOptions,
        onProviderChange: options.setProvider,
        onModelChange: options.setModel,
        onThinkingChange: options.setThinking,
      }}
      notice={issue.resolutionSessionId ? (
        <div className="rounded bg-status-waiting/10 px-2 py-1 text-[10px] text-status-waiting">
          该问题已有处理会话；创建成功后，新会话将接替后续处理。
        </div>
      ) : undefined}
      pickingDirectory={pickingDirectory}
      prompt={prompt}
      sourceLabel="本机"
      title="新建处理会话"
      workingDirectory={workingDirectory}
      onAdapterChange={(next) => {
        setAdapterId(next);
        setLastAdapter(next);
      }}
      onBrowseDirectory={() => void browse()}
      onClose={close}
      onCreate={() => void submit()}
      onPromptChange={setPrompt}
      onWorkingDirectoryChange={setWorkingDirectory}
    />
  );
}
