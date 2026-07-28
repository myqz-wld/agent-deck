import { useEffect, useId, useRef, useState, type JSX } from 'react';
import { DeckSelect } from '@renderer/components/DeckSelect';
import { SessionModelDisclosure } from '@renderer/components/SessionModelDisclosure';
import { useImageAttachments } from '@renderer/hooks/useImageAttachments';
import { useSessionCreationOptions } from '@renderer/hooks/useSessionCreationOptions';
import { CloseIcon, FolderOpenIcon, SendIcon } from './icons';
import {
  getLastAdapter,
  setLastAdapter,
} from '@renderer/hooks/useLastSessionDefaults';
import {
  PERMISSION_OPTIONS,
  CODEX_SANDBOX_OPTIONS,
  CLAUDE_SANDBOX_OPTIONS,
} from '@renderer/lib/sandbox-options';
import { errorMessage } from '@renderer/lib/error-message';
import { adapterSessionModeOptions } from '@renderer/lib/adapter-session-modes';
import type { AdapterSessionMode } from '@shared/types';
import { GrokSandboxPicker } from './GrokSandboxPicker';
import { CodexApprovalPolicyPicker } from './CodexApprovalPolicyPicker';
import { FirstMessageAuthoring } from './new-session/FirstMessageAuthoring';

interface AdapterInfo {
  id: string;
  displayName: string;
  capabilities: {
    canCreateSession?: boolean;
    canSetPermissionMode?: boolean;
    canSetSessionMode?: boolean;
    canCollaborate?: boolean;
    canAcceptAttachments?: boolean;
  };
  sessionModes: AdapterSessionMode[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
}

export function NewSessionDialog({ open, onClose, onCreated }: Props): JSX.Element | null {
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [agentId, setAgentId] = useState<string>(() => getLastAdapter());
  const [cwd, setCwd] = useState('');
  const [prompt, setPrompt] = useState('');
  const sessionOptions = useSessionCreationOptions({
    adapterId: agentId,
    cwd,
    active: open,
  });
  const {
    permissionMode,
    sessionMode,
    approvalPolicy,
    codexSandbox,
    claudeCodeSandbox,
    grokSandbox,
    provider,
    model,
    thinking,
  } = sessionOptions;
  const [busy, setBusy] = useState(false);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickingDirectoryRef = useRef(false);
  const openRef = useRef(open);
  const previousOpenRef = useRef(open);
  const dialogEpochRef = useRef(0);
  const createSequenceRef = useRef(0);
  const createInFlightRef = useRef(false);
  const authoringInstanceId = useId();
  const imgs = useImageAttachments();

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
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    void window.api
      .listAdapters()
      .then((rows) => {
        if (cancelled) return;
        const usable = rows.filter((a) => a.capabilities.canCreateSession);
        setAdapters(usable);
        if (usable.length > 0) {
          setAgentId((current) => {
            const next =
              usable.find((a) => a.id === current)?.id
              ?? usable.find((a) => a.id === getLastAdapter())?.id
              ?? usable[0].id;
            setLastAdapter(next);
            return next;
          });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(`运行时读取失败：${errorMessage(err)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const selectedAdapter = adapters.find((a) => a.id === agentId);
  const showPermissionMode = selectedAdapter?.capabilities.canSetPermissionMode ?? false;
  const showSessionMode =
    selectedAdapter?.capabilities.canSetSessionMode === true &&
    selectedAdapter.sessionModes.length > 0;
  const showCodexSandbox = agentId === 'codex-cli';
  const showClaudeCodeSandbox = agentId === 'claude-code';
  const showGrokSandbox = agentId === 'grok-build';

  const browse = async (): Promise<void> => {
    if (busy || pickingDirectoryRef.current) return;
    const epoch = dialogEpochRef.current;
    pickingDirectoryRef.current = true;
    setPickingDirectory(true);
    try {
      const r = await window.api.chooseDirectory(cwd.trim() ? cwd : undefined);
      if (r && openRef.current && epoch === dialogEpochRef.current) setCwd(r);
    } catch (err) {
      if (openRef.current && epoch === dialogEpochRef.current) {
        setError(`目录选择失败：${(err as Error).message}`);
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
    if (!prompt.trim() && imgs.attachments.length === 0) {
      setError('请输入第一条消息或添加图片');
      return;
    }
    if (
      imgs.attachments.length > 0 &&
      selectedAdapter?.capabilities.canAcceptAttachments !== true
    ) {
      setError('当前运行时的已协商能力不支持图片输入；图片仍保留，可切换运行时后重试。');
      return;
    }
    createInFlightRef.current = true;
    const requestSequence = ++createSequenceRef.current;
    const dialogEpoch = dialogEpochRef.current;
    setBusy(true);
    let attachmentInputs: ReturnType<typeof imgs.toIpcInputs>;
    try {
      attachmentInputs = imgs.toIpcInputs();
    } catch (err) {
      createInFlightRef.current = false;
      if (requestSequence === createSequenceRef.current) {
        setBusy(false);
        setError(`附件读取失败：${(err as Error).message}`);
      }
      return;
    }
    try {
      const id = await window.api.createAdapterSession(agentId, {
        cwd: cwd.trim(),
        prompt: prompt.trim() || undefined,
        permissionMode: showPermissionMode ? permissionMode : undefined,
        sessionMode: showSessionMode ? sessionMode : undefined,
        approvalPolicy: showCodexSandbox ? approvalPolicy : undefined,
        codexSandbox: showCodexSandbox ? codexSandbox : undefined,
        claudeCodeSandbox: showClaudeCodeSandbox ? claudeCodeSandbox : undefined,
        grokSandbox: showGrokSandbox ? grokSandbox.trim() : undefined,
        ...((agentId === 'claude-code' || agentId === 'codex-cli') && provider.trim()
          ? { provider: provider.trim() }
          : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(thinking ? { thinking } : {}),
        ...(attachmentInputs.length > 0 ? { attachments: attachmentInputs } : {}),
      });
      if (
        requestSequence !== createSequenceRef.current
        || dialogEpoch !== dialogEpochRef.current
        || !openRef.current
      ) {
        return;
      }
      onCreated(id);
      setPrompt('');
      imgs.clear();
      dialogEpochRef.current += 1;
      createSequenceRef.current += 1;
      createInFlightRef.current = false;
      onClose();
    } catch (e) {
      if (
        requestSequence === createSequenceRef.current
        && dialogEpoch === dialogEpochRef.current
        && openRef.current
      ) {
        setError((e as Error).message);
      }
    } finally {
      if (
        requestSequence === createSequenceRef.current
        && dialogEpoch === dialogEpochRef.current
      ) {
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
    onClose();
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="no-drag w-[340px] max-h-[85%] overflow-y-auto scrollbar-deck rounded-xl border border-deck-border bg-deck-bg-strong p-4 shadow-2xl">
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-[13px] font-medium">新建会话</h2>
          <button
            type="button"
            onClick={close}
            aria-label="关闭新建会话"
            className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-deck-muted hover:bg-white/10"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        </header>

        {adapters.length === 0 ? (
          <div className={error ? 'text-[11px] text-status-waiting' : 'text-[11px] text-deck-muted'}>
            {error ?? '没有可用的运行时'}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Field label="运行时">
              <DeckSelect
                value={agentId}
                onChange={(next) => {
                  setAgentId(next);
                  setLastAdapter(next);
                }}
                options={adapters.map((a) => ({ value: a.id, label: a.displayName }))}
                buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px] outline-none focus:border-white/20"
              />
            </Field>

            <SessionModelDisclosure
              adapterId={agentId}
              provider={provider}
              model={model}
              thinking={thinking}
              disabled={busy}
              onProviderChange={sessionOptions.setProvider}
              onModelChange={sessionOptions.setModel}
              onThinkingChange={sessionOptions.setThinking}
            />

            <Field label="工作目录">
              <div className="flex gap-1">
                <input
                  type="text"
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  placeholder="留空则使用主目录（~）"
                  className="flex-1 rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-[11px] outline-none focus:border-white/20"
                />
                <button
                  type="button"
                  onClick={() => void browse()}
                  disabled={busy || pickingDirectory}
                  className="shrink-0 rounded bg-white/10 px-2 text-[10px] hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {!pickingDirectory && <FolderOpenIcon className="mr-1 inline h-3 w-3" />}
                  {pickingDirectory ? '选择中…' : '选择…'}
                </button>
              </div>
            </Field>

            <FirstMessageAuthoring
              identitySessionId={`new-session:${authoringInstanceId}`}
              prompt={prompt}
              onPromptChange={setPrompt}
              images={imgs}
              acceptsAttachments={
                selectedAdapter?.capabilities.canAcceptAttachments === true
              }
              busy={busy}
            />

            {showPermissionMode && (
              <Field label="权限模式">
                <DeckSelect
                  value={permissionMode}
                  onChange={sessionOptions.setPermissionMode}
                  options={PERMISSION_OPTIONS}
                  buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px] outline-none focus:border-white/20"
                />
              </Field>
            )}

            {showSessionMode && (
              <Field label="工作模式">
                <DeckSelect
                  value={sessionMode}
                  onChange={sessionOptions.setSessionMode}
                  options={adapterSessionModeOptions(selectedAdapter.sessionModes)}
                  buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px] outline-none focus:border-white/20"
                />
              </Field>
            )}

            {showCodexSandbox && (
              <Field label="审批策略">
                <CodexApprovalPolicyPicker
                  ariaLabel="审批策略"
                  value={approvalPolicy}
                  onChange={sessionOptions.setApprovalPolicy}
                  buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px] outline-none focus:border-white/20"
                />
              </Field>
            )}

            {showCodexSandbox && (
              <Field label="沙盒">
                <DeckSelect
                  value={codexSandbox}
                  onChange={sessionOptions.setCodexSandbox}
                  options={CODEX_SANDBOX_OPTIONS}
                  buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px] outline-none focus:border-white/20"
                />
              </Field>
            )}

            {showClaudeCodeSandbox && (
              <Field label="系统沙盒">
                <DeckSelect
                  value={claudeCodeSandbox}
                  onChange={sessionOptions.setClaudeCodeSandbox}
                  options={CLAUDE_SANDBOX_OPTIONS}
                  buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-2 py-1 text-left text-[11px] outline-none focus:border-white/20"
                />
              </Field>
            )}

            {showGrokSandbox && (
              <Field label="Grok Build 沙盒（请求档位）">
                <GrokSandboxPicker
                  value={grokSandbox}
                  onChange={sessionOptions.setGrokSandbox}
                  allowUnset={false}
                  disabled={busy}
                  ariaLabel="Grok Build 沙盒请求档位"
                />
              </Field>
            )}

            {error && (
              <div className="rounded bg-status-waiting/10 px-2 py-1 text-[11px] text-status-waiting">
                {error}
              </div>
            )}

            <div className="mt-1 flex justify-end gap-2">
              <button
                type="button"
                onClick={close}
                className="rounded px-3 py-1 text-[11px] text-deck-muted hover:bg-white/5"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy || (!prompt.trim() && imgs.attachments.length === 0)}
                className="rounded bg-status-working/30 px-3 py-1 text-[11px] text-status-working hover:bg-status-working/40 disabled:opacity-50"
              >
                {!busy && <SendIcon className="mr-1 inline h-3 w-3" />}
                {busy ? '创建中…' : '创建'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-deck-muted/70">{label}</span>
      {children}
    </label>
  );
}
