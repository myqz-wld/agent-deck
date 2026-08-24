import { useEffect, useRef, useState, type JSX } from 'react';

import type { SessionThinkingChoice } from '../SessionModelFields';
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
  type CodexSandboxMode,
} from '@renderer/lib/sandbox-options';
import { adapterSessionModeOptions } from '@renderer/lib/adapter-session-modes';
import type { RemoteHostJsonObject } from '@shared/remote-host';
import type { SessionConsoleCreateOptionSchema } from '@contracts/index';
import {
  ADAPTER_SESSION_MODES,
  isSelectablePermissionMode,
} from '@shared/types';
import { SessionRuntimeFieldsView } from './composer-sdk/SessionRuntimeFieldsView';
import { errorMessage } from '@renderer/lib/error-message';

const MODEL_PERSIST_DELAY_MS = 250;
const CUSTOM_GROK_PROFILE = '__agent_deck_remote_custom_grok_sandbox__';
const PROVIDER_DEFAULT_RUNTIME_VALUE = '__agent_deck_provider_default__';
const PROVIDER_DEFAULT_RUNTIME_OPTION = {
  value: PROVIDER_DEFAULT_RUNTIME_VALUE,
  label: '使用当前默认值',
  disabled: true,
};

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

interface RuntimeAuthority {
  eligible: boolean;
  identity: string;
}

type ApplyPatchResult = 'applied' | 'deferred' | 'failed' | 'stale';

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
  optionSchema = null,
  onApply,
}: {
  adapterId: string;
  busy: boolean;
  canWrite: boolean;
  identity: string;
  turnActive?: boolean;
  values: RemoteHostJsonObject | null;
  optionSchema?: SessionConsoleCreateOptionSchema | null;
  onApply: (patch: RemoteHostJsonObject) => Promise<void>;
}): JSX.Element {
  const [model, setModel] = useState('');
  const [provider, setProvider] = useState('');
  const [thinking, setThinking] = useState<SessionThinkingChoice>('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const modelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeIdentity = useRef(identity);
  const authority = useRef<RuntimeAuthority>({
    eligible: canWrite && !busy && values !== null,
    identity,
  });
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
  const eligible = canWrite && !busy && values !== null;
  authority.current = {
    eligible,
    identity,
  };
  const disabled = busy || !canWrite || !values;

  const applyPatch = async (
    patch: RemoteHostJsonObject,
    apply: (value: RemoteHostJsonObject) => Promise<void>,
    originIdentity: string,
  ): Promise<ApplyPatchResult> => {
    const task = applyTail.current.then(async () => {
      const current = authority.current;
      if (!mounted.current || current.identity !== originIdentity) return 'stale' as const;
      if (!current.eligible) return 'deferred' as const;
      await apply(patch);
      return 'applied' as const;
    });
    applyTail.current = task.then(() => undefined, () => undefined);
    try {
      const result = await task;
      if (result !== 'applied') return result;
      if (mounted.current && activeIdentity.current === originIdentity) setError(null);
      return 'applied';
    } catch (cause) {
      if (mounted.current && activeIdentity.current === originIdentity) {
        setError(errorMessage(cause));
      }
      return 'failed';
    }
  };

  const persistSelection = (pending: PendingSelection): void => {
    const { selection, apply } = pending;
    void applyPatch({
      provider: selection.provider.trim() || null,
      model: selection.model.trim() || null,
      thinking: selection.thinking || null,
    }, apply, selection.identity).then((result) => {
      const current = draft.current.selection;
      const isCurrent = current.identity === selection.identity &&
        current.revision === selection.revision;
      if (result === 'applied' && isCurrent) {
        draft.current.hasLocalEdits = false;
        if (mounted.current) setNotice(null);
        return;
      }
      if (
        result === 'deferred' && isCurrent && mounted.current &&
        activeIdentity.current === selection.identity
      ) {
        pendingSelection.current = pending;
        setNotice('当前会话正忙，模型编辑将在空闲后自动保存。');
        if (authority.current.eligible) queueMicrotask(flushSelection);
      }
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
    setNotice(null);
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
      const discardedLocalEdits = current.hasLocalEdits;
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
      setNotice(discardedLocalEdits
        ? '会话已切换，上一会话尚未保存的模型编辑已丢弃。'
        : null);
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
  useEffect(() => {
    if (!eligible) return;
    const pending = pendingSelection.current;
    if (pending?.selection.identity === identity) flushSelection();
  }, [eligible, identity]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flushSelection();
    };
  }, []);

  const apply = async (patch: RemoteHostJsonObject): Promise<boolean> => {
    setError(null);
    return (await applyPatch(patch, onApply, identity)) === 'applied';
  };
  const currentPermission = stringValue(values, 'permissionMode');
  const permissionOptions = currentPermission === 'dontAsk'
    ? [{ value: 'dontAsk', label: '当前状态：不询问（只读）', disabled: true },
        ...PERMISSION_MODE_OPTIONS]
    : [PROVIDER_DEFAULT_RUNTIME_OPTION, ...PERMISSION_MODE_OPTIONS];
  const claudeSandbox = stringValue(values, 'claudeCodeSandbox');
  const approvalPolicy = stringValue(values, 'approvalPolicy');
  const codexSandbox = stringValue(values, 'codexSandbox');
  const sessionMode = stringValue(values, 'sessionMode');
  const providerDescriptor = optionSchema?.provider;
  const modelDescriptor = optionSchema?.model;
  const thinkingDescriptor = optionSchema?.thinking;

  return (
    <>
      <SessionRuntimeFieldsView
        fields={{
          adapterId,
          provider,
          model,
          thinking,
          disabled,
          providerOptions: providerDescriptor?.allowedValues?.map((id) => ({ id })) ?? [],
          thinkingOptions: thinkingDescriptor?.allowedValues?.map((value) => ({
            value: value as SessionThinkingChoice,
            label: value ? value.toUpperCase() : '使用当前默认值',
          })),
          disabledReasons: {
            provider: providerDescriptor?.disabledReason,
            model: modelDescriptor?.disabledReason,
            thinking: thinkingDescriptor?.disabledReason,
          },
          onProviderChange: (next) => updateSelection({ provider: next, model: '' }, true),
          onModelChange: (next) => updateSelection({ model: next }, false),
          onModelBlur: flushSelection,
          onThinkingChange: (next) => updateSelection({ thinking: next }, true),
        }}
        help={adapterId === 'grok-build'
          ? '当前回复不会中断，修改会自动保存并从下一轮生效。'
          : '当前回复不会中断；模型网关、模型与思考程度会自动保存并从下一轮生效。'}
        error={null}
        onDismissError={() => undefined}
      />
      {adapterId === 'claude-code' && (
        <>
          <SelectRow
            label="权限"
            value={currentPermission || PROVIDER_DEFAULT_RUNTIME_VALUE}
            options={permissionOptions}
            disabled={disabled}
            onChange={(next) => {
              if (next !== PROVIDER_DEFAULT_RUNTIME_VALUE && isSelectablePermissionMode(next)) {
                void apply({ permissionMode: next });
              }
            }}
          />
          <SelectRow
            label="沙盒"
            value={claudeSandbox || PROVIDER_DEFAULT_RUNTIME_VALUE}
            options={[PROVIDER_DEFAULT_RUNTIME_OPTION, ...CLAUDE_CODE_SANDBOX_OPTIONS]}
            disabled={disabled}
            onChange={(next) => {
              if (next !== PROVIDER_DEFAULT_RUNTIME_VALUE) {
                void confirmClaudeSandbox(next as ClaudeSandboxMode, apply);
              }
            }}
          />
        </>
      )}
      {adapterId === 'codex-cli' && (
        <>
          <SelectRow
            label="审批"
            value={approvalPolicy || PROVIDER_DEFAULT_RUNTIME_VALUE}
            options={[PROVIDER_DEFAULT_RUNTIME_OPTION, ...CODEX_APPROVAL_POLICY_OPTIONS]}
            disabled={disabled}
            onChange={(next) => {
              if (next !== PROVIDER_DEFAULT_RUNTIME_VALUE) void apply({ approvalPolicy: next });
            }}
          />
          <SelectRow
            label="沙盒"
            value={codexSandbox || PROVIDER_DEFAULT_RUNTIME_VALUE}
            options={[PROVIDER_DEFAULT_RUNTIME_OPTION, ...CODEX_SANDBOX_OPTIONS]}
            disabled={disabled}
            onChange={(next) => {
              if (next !== PROVIDER_DEFAULT_RUNTIME_VALUE) {
                void confirmCodexSandbox(next as CodexSandboxMode, apply);
              }
            }}
          />
        </>
      )}
      {adapterId === 'grok-build' && (
        <>
          <SelectRow
            label="模式"
            value={sessionMode || PROVIDER_DEFAULT_RUNTIME_VALUE}
            options={[
              PROVIDER_DEFAULT_RUNTIME_OPTION,
              ...adapterSessionModeOptions(ADAPTER_SESSION_MODES),
            ]}
            disabled={disabled}
            onChange={(next) => {
              if (next !== PROVIDER_DEFAULT_RUNTIME_VALUE) void apply({ sessionMode: next });
            }}
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
          当前只能查看运行设置，不能在这里修改。
        </p>
      )}
      {notice && (
        <div
          role="status"
          className="mb-1.5 rounded border border-amber-300/20 bg-amber-300/[0.06] px-2 py-1.5 text-[10px] leading-relaxed text-amber-100/80"
        >
          {notice}
        </div>
      )}
      <ErrorBanner message={error} prefix="运行设置失败" onDismiss={() => setError(null)} />
    </>
  );
}

async function confirmClaudeSandbox(
  next: ClaudeSandboxMode,
  apply: (patch: RemoteHostJsonObject) => Promise<boolean>,
): Promise<void> {
  if (next === 'off' && !await window.api.confirmDialog({
    title: '关闭 Claude Code 系统沙盒',
    message: '需要重启当前 Claude Code 会话',
    detail: '重启后，Claude Code 不再受系统沙盒约束。失败时会自动恢复当前设置。继续？',
    okLabel: '重启并关闭沙盒', cancelLabel: '取消', destructive: true,
  })) return;
  await apply({ claudeCodeSandbox: next });
}

async function confirmCodexSandbox(
  next: CodexSandboxMode,
  apply: (patch: RemoteHostJsonObject) => Promise<boolean>,
): Promise<void> {
  if (next === 'danger-full-access' && !await window.api.confirmDialog({
    title: '关闭 Codex CLI 沙盒（完全开放）',
    message: '将从 Codex CLI 的下一轮对话起生效',
    detail: '关闭后，Codex CLI 可以读写任意文件、执行任意命令。失败时会自动恢复当前设置。继续？',
    okLabel: '关闭沙盒', cancelLabel: '取消', destructive: true,
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
          ariaLabel="沙盒"
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
          <input value={draft} onChange={(event) => setDraft(event.target.value)} disabled={disabled} maxLength={128} aria-label="自定义沙盒配置名称" className="min-w-0 flex-1 rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-[10px]" />
          <button type="button" disabled={disabled || !draft.trim()} onClick={() => void onApply(draft.trim())} className="rounded bg-white/10 px-2 text-[10px] disabled:opacity-40">应用</button>
        </div>
      )}
    </div>
  );
}
