import { useEffect, useRef, useState, type JSX } from 'react';

import { SessionModelFields, type SessionThinkingChoice } from '../SessionModelFields';
import { DeckSelect } from '../DeckSelect';
import {
  CLAUDE_CODE_SANDBOX_OPTIONS,
  CODEX_SANDBOX_OPTIONS,
  PERMISSION_MODE_OPTIONS,
  SelectRow,
} from './composer-sdk/SandboxSelects';
import { ErrorBanner } from './composer-sdk/ErrorBanner';
import {
  CODEX_APPROVAL_POLICY_OPTIONS,
  GROK_SANDBOX_MODE_OPTIONS,
  type ClaudeSandboxMode,
  type CodexApprovalPolicyChoice,
  type CodexSandboxMode,
} from '@renderer/lib/sandbox-options';
import { adapterSessionModeOptions } from '@renderer/lib/adapter-session-modes';
import type { RemoteHostJsonObject } from '@shared/remote-host';
import {
  ADAPTER_SESSION_MODES,
  isSelectablePermissionMode,
  type AdapterSessionMode,
  type PermissionMode,
} from '@shared/types';

const MODEL_PERSIST_DELAY_MS = 250;
const CUSTOM_GROK_PROFILE = '__agent_deck_remote_custom_grok_sandbox__';

interface RuntimeSelection {
  identity: string;
  provider: string;
  model: string;
  thinking: SessionThinkingChoice;
  revision: number;
}

interface PendingSelection {
  selection: RuntimeSelection;
  apply: (patch: RemoteHostJsonObject) => Promise<void>;
}

function stringValue(values: RemoteHostJsonObject | null, key: string): string {
  const value = values?.[key];
  return typeof value === 'string' ? value : '';
}

export function RemoteSessionRuntimeControls({
  adapterId,
  busy,
  canWrite,
  identity,
  values,
  onApply,
}: {
  adapterId: string;
  busy: boolean;
  canWrite: boolean;
  identity: string;
  values: RemoteHostJsonObject | null;
  onApply: (patch: RemoteHostJsonObject) => Promise<void>;
}): JSX.Element {
  const [model, setModel] = useState('');
  const [provider, setProvider] = useState('');
  const [thinking, setThinking] = useState<SessionThinkingChoice>('');
  const [error, setError] = useState<string | null>(null);
  const modelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeIdentity = useRef(identity);
  const mounted = useRef(true);
  const applyRef = useRef(onApply);
  const applyTail = useRef<Promise<void>>(Promise.resolve());
  const pendingSelection = useRef<PendingSelection | null>(null);
  const draft = useRef<{
    selection: RuntimeSelection;
    hasLocalEdits: boolean;
  }>({
    selection: {
      identity,
      provider: stringValue(values, 'provider'),
      model: stringValue(values, 'model'),
      thinking: stringValue(values, 'thinking') as SessionThinkingChoice,
      revision: 0,
    },
    hasLocalEdits: false,
  });
  applyRef.current = onApply;
  activeIdentity.current = identity;
  const disabled = busy || !canWrite || !values;

  const applyPatch = async (
    patch: RemoteHostJsonObject,
    apply: (value: RemoteHostJsonObject) => Promise<void>,
    originIdentity: string,
  ): Promise<boolean> => {
    const task = applyTail.current.then(() => apply(patch));
    applyTail.current = task.then(() => undefined, () => undefined);
    try {
      await task;
      if (mounted.current && activeIdentity.current === originIdentity) setError(null);
      return true;
    } catch (cause) {
      if (mounted.current && activeIdentity.current === originIdentity) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
      return false;
    }
  };

  const persistSelection = (pending: PendingSelection): void => {
    const { selection, apply } = pending;
    void applyPatch({
      provider: selection.provider.trim() || null,
      model: selection.model.trim() || null,
      thinking: selection.thinking || null,
    }, apply, selection.identity).then((ok) => {
      const current = draft.current.selection;
      if (
        ok && current.identity === selection.identity &&
        current.revision === selection.revision
      ) draft.current.hasLocalEdits = false;
    });
  };

  const flushSelection = (): void => {
    if (modelTimer.current) clearTimeout(modelTimer.current);
    modelTimer.current = null;
    const pending = pendingSelection.current;
    pendingSelection.current = null;
    if (pending) persistSelection(pending);
  };

  const updateSelection = (
    patch: Partial<Pick<RuntimeSelection, 'provider' | 'model' | 'thinking'>>,
    immediate: boolean,
  ): void => {
    const current = draft.current.selection.identity === identity
      ? draft.current.selection
      : {
          identity,
          provider: stringValue(values, 'provider'),
          model: stringValue(values, 'model'),
          thinking: stringValue(values, 'thinking') as SessionThinkingChoice,
          revision: draft.current.selection.revision + 1,
        };
    const selection = { ...current, ...patch, revision: current.revision + 1 };
    draft.current = { selection, hasLocalEdits: true };
    setProvider(selection.provider);
    setModel(selection.model);
    setThinking(selection.thinking);
    setError(null);
    pendingSelection.current = { selection, apply: applyRef.current };
    if (immediate) {
      flushSelection();
      return;
    }
    if (modelTimer.current) clearTimeout(modelTimer.current);
    modelTimer.current = setTimeout(() => {
      modelTimer.current = null;
      const pending = pendingSelection.current;
      pendingSelection.current = null;
      if (pending) persistSelection(pending);
    }, MODEL_PERSIST_DELAY_MS);
  };

  useEffect(() => {
    const current = draft.current;
    if (current.selection.identity !== identity) {
      flushSelection();
      const selection = {
        identity,
        provider: stringValue(values, 'provider'),
        model: stringValue(values, 'model'),
        thinking: stringValue(values, 'thinking') as SessionThinkingChoice,
        revision: current.selection.revision + 1,
      };
      draft.current = { selection, hasLocalEdits: false };
      setProvider(selection.provider);
      setModel(selection.model);
      setThinking(selection.thinking);
      setError(null);
      return;
    }
    if (current.hasLocalEdits) return;
    const selection = {
      identity,
      provider: stringValue(values, 'provider'),
      model: stringValue(values, 'model'),
      thinking: stringValue(values, 'thinking') as SessionThinkingChoice,
      revision: current.selection.revision + 1,
    };
    draft.current = { selection, hasLocalEdits: false };
    setProvider(selection.provider);
    setModel(selection.model);
    setThinking(selection.thinking);
  }, [identity, values?.model, values?.provider, values?.thinking]);
  useEffect(() => () => { mounted.current = false; flushSelection(); }, []);

  const apply = async (patch: RemoteHostJsonObject): Promise<boolean> => {
    setError(null);
    return applyPatch(patch, applyRef.current, identity);
  };
  const currentPermission = (stringValue(values, 'permissionMode') || 'default') as PermissionMode;
  const permissionOptions = currentPermission === 'dontAsk'
    ? [{ value: 'dontAsk' as const, label: '模型提供方状态：不询问（只读）', disabled: true },
        ...PERMISSION_MODE_OPTIONS]
    : [...PERMISSION_MODE_OPTIONS];

  return (
    <>
      <details className="mb-2 rounded border border-deck-border/80 bg-white/[0.02] px-2 py-1.5">
        <summary className="cursor-pointer select-none text-[10px] text-deck-muted">
          {adapterId === 'codex-cli' ? 'Provider' : adapterId === 'claude-code' ? 'Gateway' : '运行时'}、模型与思考程度
          <span className="ml-1 text-deck-muted/60">（下一轮生效）</span>
        </summary>
        <div className="mt-2 space-y-2">
          <SessionModelFields
            adapterId={adapterId}
            provider={provider}
            model={model}
            thinking={thinking}
            disabled={disabled}
            providerOptions={[]}
            onProviderChange={(next) => updateSelection({ provider: next, model: '' }, true)}
            onModelChange={(next) => updateSelection({ model: next }, false)}
            onThinkingChange={(next) => updateSelection({ thinking: next }, true)}
          />
          <p className="text-[9px] text-deck-muted/65">
            这些值直接写入当前 Remote Worker 的会话运行时；不会调用本机会话 IPC。
          </p>
        </div>
      </details>
      {adapterId === 'claude-code' && (
        <>
          <SelectRow
            label="权限"
            value={currentPermission}
            options={permissionOptions}
            disabled={disabled}
            onChange={(next) => {
              if (isSelectablePermissionMode(next)) void apply({ permissionMode: next });
            }}
          />
          <SelectRow
            label="沙盒"
            value={(stringValue(values, 'claudeCodeSandbox') || 'off') as ClaudeSandboxMode}
            options={CLAUDE_CODE_SANDBOX_OPTIONS}
            disabled={disabled}
            onChange={(next) => void confirmClaudeSandbox(next, apply)}
          />
        </>
      )}
      {adapterId === 'codex-cli' && (
        <>
          <SelectRow
            label="审批"
            value={(stringValue(values, 'approvalPolicy') || 'never') as CodexApprovalPolicyChoice}
            options={CODEX_APPROVAL_POLICY_OPTIONS}
            disabled={disabled}
            onChange={(next) => void apply({ approvalPolicy: next })}
          />
          <SelectRow
            label="沙盒"
            value={(stringValue(values, 'codexSandbox') || 'workspace-write') as CodexSandboxMode}
            options={CODEX_SANDBOX_OPTIONS}
            disabled={disabled}
            onChange={(next) => void confirmCodexSandbox(next, apply)}
          />
        </>
      )}
      {adapterId === 'grok-build' && (
        <>
          <SelectRow
            label="模式"
            value={(stringValue(values, 'sessionMode') || 'default') as AdapterSessionMode}
            options={adapterSessionModeOptions(ADAPTER_SESSION_MODES)}
            disabled={disabled}
            onChange={(next) => void apply({ sessionMode: next })}
          />
          <RemoteGrokSandbox
            value={stringValue(values, 'grokSandbox')}
            disabled={disabled}
            onApply={(next) => apply({ grokSandbox: next || null })}
          />
        </>
      )}
      {!canWrite && (
        <p className="mb-1.5 text-[9px] text-deck-muted/70">
          此 Remote Core 未提供会话运行时写入能力；控件只显示权威值。
        </p>
      )}
      <ErrorBanner message={error} prefix="远端运行时设置失败" onDismiss={() => setError(null)} />
    </>
  );
}

async function confirmClaudeSandbox(
  next: ClaudeSandboxMode,
  apply: (patch: RemoteHostJsonObject) => Promise<boolean>,
): Promise<void> {
  if (next === 'off' && !await window.api.confirmDialog({
    title: '关闭 Remote Claude Code 系统沙盒',
    message: '需要在 Worker 上重启当前会话',
    detail: '重启由远端 Core 受控执行，不会重启本机 Agent Deck。继续？',
    okLabel: '重启并关闭沙盒', cancelLabel: '取消', destructive: true,
  })) return;
  await apply({ claudeCodeSandbox: next });
}

async function confirmCodexSandbox(
  next: CodexSandboxMode,
  apply: (patch: RemoteHostJsonObject) => Promise<boolean>,
): Promise<void> {
  if (next === 'danger-full-access' && !await window.api.confirmDialog({
    title: '开放 Remote Codex CLI 沙盒',
    message: '后续轮次将在 Worker 上使用完全开放权限',
    detail: '此操作仅影响当前远端会话，不会修改本机会话。继续？',
    okLabel: '完全开放', cancelLabel: '取消', destructive: true,
  })) return;
  await apply({ codexSandbox: next });
}

function RemoteGrokSandbox({
  value,
  disabled,
  onApply,
}: {
  value: string;
  disabled: boolean;
  onApply: (value: string) => Promise<boolean>;
}): JSX.Element {
  const builtIn = GROK_SANDBOX_MODE_OPTIONS.some((option) => option.value === value);
  const custom = value !== '' && !builtIn;
  const [customActive, setCustomActive] = useState(custom);
  const [draft, setDraft] = useState(custom ? value : '');
  useEffect(() => { setCustomActive(custom); if (custom) setDraft(value); }, [custom, value]);
  return (
    <div className="mb-1.5">
      <div className="flex items-center gap-1.5 text-[10px] text-deck-muted">
        <span>沙盒</span>
        <DeckSelect
          value={customActive ? CUSTOM_GROK_PROFILE : value}
          onChange={(next) => {
            if (next === CUSTOM_GROK_PROFILE) { setCustomActive(true); return; }
            setCustomActive(false);
            void onApply(next);
          }}
          disabled={disabled}
          options={[
            { value: '', label: '跟随 Grok Build 原生配置' },
            ...GROK_SANDBOX_MODE_OPTIONS,
            { value: CUSTOM_GROK_PROFILE, label: '自定义配置…' },
          ]}
          className="min-w-0 flex-1"
          buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-left text-[10px] outline-none focus:border-white/20 disabled:opacity-50"
        />
      </div>
      {customActive && (
        <div className="mt-1 flex gap-1">
          <input value={draft} onChange={(event) => setDraft(event.target.value)} disabled={disabled} maxLength={128} aria-label="Remote Grok 自定义沙盒配置名称" className="min-w-0 flex-1 rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-[10px]" />
          <button type="button" disabled={disabled || !draft.trim()} onClick={() => void onApply(draft.trim())} className="rounded bg-white/10 px-2 text-[10px] disabled:opacity-40">应用</button>
        </div>
      )}
    </div>
  );
}
