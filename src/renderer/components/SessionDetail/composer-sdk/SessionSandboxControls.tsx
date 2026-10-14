import { useRuntimeChangeConfirmation } from '@renderer/hooks/useRuntimeChangeConfirmation';
import { useEffect, useState, type JSX } from 'react';
import type { SessionRecord } from '@shared/types';
import { SDK_RESTART_RESUME_PROMPT } from '@shared/restart-prompts';
import { isGrokBuiltinSandboxProfile } from '@shared/grok-sandbox';
import {
  GROK_SANDBOX_MODE_OPTIONS,
  type ClaudeSandboxMode,
  type CodexSandboxMode,
} from '@renderer/lib/sandbox-options';
import { DeckSelect } from '@renderer/components/DeckSelect';
import {
  CLAUDE_CODE_SANDBOX_OPTIONS,
  CODEX_SANDBOX_OPTIONS,
  SelectRow,
} from './SandboxSelects';
import { ErrorBanner } from './ErrorBanner';

const CUSTOM_GROK_PROFILE = '__agent_deck_custom_grok_sandbox__';

export function SessionSandboxControls({
  session,
}: {
  session: SessionRecord;
  turnBusy: boolean;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmChange = useRuntimeChangeConfirmation(`${session.agentId}:${session.id}`);

  const changeCodex = async (next: CodexSandboxMode): Promise<void> => {
    const current = session.codexSandbox ?? 'workspace-write';
    if (next === current || busy) return;
    if (!await confirmChange({ adapterId: session.agentId, kind: 'sandbox', value: next })) return;
    await run(async () =>
      window.api.setCodexSandbox(
        session.agentId,
        session.id,
        next,
      ),
    );
  };

  const changeClaude = async (next: ClaudeSandboxMode): Promise<void> => {
    const current = session.claudeCodeSandbox ?? 'off';
    if (next === current || busy) return;
    if (!await confirmChange({ adapterId: session.agentId, kind: 'sandbox', value: next })) return;
    await run(async () =>
      window.api.restartWithClaudeCodeSandbox(
        session.agentId,
        session.id,
        next,
        SDK_RESTART_RESUME_PROMPT,
      ),
    );
  };

  const run = async (operation: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {session.agentId === 'codex-cli' && (
        <>
          <SelectRow
            label="沙盒"
            value={(session.codexSandbox ?? 'workspace-write') as CodexSandboxMode}
            options={CODEX_SANDBOX_OPTIONS}
            disabled={busy}
            onChange={(next) => void changeCodex(next)}
          />
        </>
      )}
      {session.agentId === 'claude-code' && (
        <SelectRow
          label="沙盒"
          value={(session.claudeCodeSandbox ?? 'off') as ClaudeSandboxMode}
          options={CLAUDE_CODE_SANDBOX_OPTIONS}
          disabled={busy}
          onChange={(next) => void changeClaude(next)}
        />
      )}
      {session.agentId === 'grok-build' && (
        <GrokSessionSandboxControl
          session={session}
          disabled={busy}
          run={run}
          confirmChange={confirmChange}
        />
      )}
      <ErrorBanner
        message={error}
        prefix="运行时设置切换失败"
        onDismiss={() => setError(null)}
      />
    </>
  );
}

function GrokSessionSandboxControl({
  session,
  disabled,
  run,
  confirmChange,
}: {
  session: SessionRecord;
  disabled: boolean;
  run: (operation: () => Promise<unknown>) => Promise<boolean>;
  confirmChange: ReturnType<typeof useRuntimeChangeConfirmation>;
}): JSX.Element {
  const current = session.grokSandbox ?? '';
  const currentIsSelectableBuiltin = GROK_SANDBOX_MODE_OPTIONS.some(
    (option) => option.value === current,
  );
  const currentIsCustom =
    current !== '' &&
    (!isGrokBuiltinSandboxProfile(current) || !currentIsSelectableBuiltin);
  const [customActive, setCustomActive] = useState(currentIsCustom);
  const [draft, setDraft] = useState(currentIsCustom ? current : '');

  useEffect(() => {
    setCustomActive(currentIsCustom);
    if (currentIsCustom) setDraft(current);
  }, [current, currentIsCustom]);

  const apply = async (profile: string | null): Promise<boolean> => {
    if (profile === current || (profile === null && current === '')) return true;
    if (!await confirmChange({ adapterId: session.agentId, kind: 'sandbox', value: profile })) return false;
    return run(() =>
      window.api.restartWithGrokSandbox(
        session.agentId,
        session.id,
        profile,
      ),
    );
  };

  const selectValue = customActive ? CUSTOM_GROK_PROFILE : current;
  return (
    <div className="mb-1.5">
      <div className="flex items-center gap-1.5 text-[10px] text-deck-muted">
        <span>沙盒</span>
        <DeckSelect
          value={selectValue}
          ariaLabel="沙盒"
          onChange={(next) => {
            if (next === CUSTOM_GROK_PROFILE) {
              setCustomActive(true);
              setDraft(currentIsCustom ? current : '');
              return;
            }
            setCustomActive(false);
            void apply(next || null).then((applied) => {
              if (applied) return;
              setCustomActive(currentIsCustom);
              if (currentIsCustom) setDraft(current);
            });
          }}
          disabled={disabled}
          options={[
            {
              value: '',
              label: '跟随 Grok Build 原生配置',
              title: '不添加 --sandbox，由 Grok Build 配置、环境变量或托管策略决定',
            },
            ...GROK_SANDBOX_MODE_OPTIONS,
            { value: CUSTOM_GROK_PROFILE, label: '自定义配置…' },
          ]}
          className="min-w-0 flex-1"
          buttonClassName="w-full rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-left text-[10px] outline-none focus:border-white/20 disabled:opacity-50"
        />
      </div>
      {customActive && (
        <div className="mt-1 flex gap-1">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={disabled}
            maxLength={128}
            placeholder="输入 sandbox.toml 配置名称"
            aria-label="自定义沙盒配置名称"
            className="min-w-0 flex-1 rounded border border-deck-border bg-white/[0.04] px-1.5 py-0.5 text-[10px] outline-none focus:border-white/20 disabled:opacity-50"
          />
          <button
            type="button"
            disabled={disabled || !draft.trim()}
            onClick={() => void apply(draft.trim())}
            className="rounded bg-white/10 px-2 text-[10px] hover:bg-white/15 disabled:opacity-40"
          >
            应用
          </button>
        </div>
      )}
    </div>
  );
}
