import { useEffect, useState, type JSX } from 'react';
import type { SessionRecord } from '@shared/types';
import { SDK_RESTART_RESUME_PROMPT } from '@shared/restart-prompts';
import { isGrokBuiltinSandboxProfile } from '@shared/grok-sandbox';
import {
  CODEX_APPROVAL_POLICY_OPTIONS,
  GROK_SANDBOX_MODE_OPTIONS,
  type ClaudeSandboxMode,
  type CodexApprovalPolicyChoice,
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
  turnBusy,
}: {
  session: SessionRecord;
  turnBusy: boolean;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = busy || turnBusy || session.activity === 'waiting';

  const changeCodexApproval = async (
    next: CodexApprovalPolicyChoice,
  ): Promise<void> => {
    const current = session.codexApprovalPolicy ?? 'on-request';
    if (next === current || busy) return;
    await run(() =>
      window.api.setCodexApprovalPolicy(session.agentId, session.id, next),
    );
  };

  const changeCodex = async (next: CodexSandboxMode): Promise<void> => {
    const current = session.codexSandbox ?? 'workspace-write';
    if (next === current || busy) return;
    if (next === 'danger-full-access') {
      const approved = await window.api.confirmDialog({
        title: '关闭 Codex CLI 沙盒（完全开放）',
        message: '将从 Codex CLI 的下一轮对话起生效',
        detail:
          '关闭后，Codex CLI 可以读写任意文件、执行任意命令。当前正在运行的轮次不会中断，后续消息会使用新设置。\n\n失败时会自动恢复当前沙盒设置。继续？',
        okLabel: '关闭沙盒',
        cancelLabel: '取消',
        destructive: true,
      });
      if (!approved) return;
    }
    await run(async () =>
      window.api.restartWithCodexSandbox(
        session.agentId,
        session.id,
        next,
        SDK_RESTART_RESUME_PROMPT,
      ),
    );
  };

  const changeClaude = async (next: ClaudeSandboxMode): Promise<void> => {
    const current = session.claudeCodeSandbox ?? 'off';
    if (next === current || busy) return;
    if (next === 'off') {
      const approved = await window.api.confirmDialog({
        title: '关闭 Claude Code 系统沙盒',
        message: '需要重启当前 Claude Code 会话',
        detail:
          '重启后，Claude Code 不再受系统沙盒约束（仅靠应用内授权弹窗管控）。重启约需 5–10 秒。\n\n失败时会自动恢复当前沙盒设置。继续？',
        okLabel: '重启并关闭沙盒',
        cancelLabel: '取消',
        destructive: true,
      });
      if (!approved) return;
    }
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
            label="审批"
            value={
              (session.codexApprovalPolicy ??
                'on-request') as CodexApprovalPolicyChoice
            }
            options={CODEX_APPROVAL_POLICY_OPTIONS}
            disabled={busy}
            onChange={(next) => void changeCodexApproval(next)}
          />
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
          disabled={disabled}
          run={run}
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
}: {
  session: SessionRecord;
  disabled: boolean;
  run: (operation: () => Promise<unknown>) => Promise<boolean>;
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
    if (profile === 'off') {
      const approved = await window.api.confirmDialog({
        title: '关闭 Grok Build 系统沙盒',
        message: '需要重启当前 Grok Build 会话',
        detail:
          '重启后，Grok Build 不再受系统沙盒约束，但工具授权规则仍然生效。仅空闲会话可以切换；失败时会自动恢复当前档位。\n\n继续？',
        okLabel: '重启并关闭沙盒',
        cancelLabel: '取消',
        destructive: true,
      });
      if (!approved) return false;
    }
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
