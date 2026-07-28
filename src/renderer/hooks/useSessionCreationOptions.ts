import { useEffect, useRef, useState } from 'react';
import type {
  AdapterSessionMode,
  SessionCreationDefaults,
} from '@shared/types';
import type { SessionThinkingChoice } from '@renderer/components/SessionModelFields';
import {
  getLastDefaults,
  setLastDefaults,
} from './useLastSessionDefaults';
import type {
  ClaudeSandboxChoice,
  CodexApprovalPolicyChoice,
  CodexSandboxChoice,
  GrokSandboxChoice,
  PermissionModeChoice,
} from '@renderer/lib/sandbox-options';

interface Options {
  adapterId: string;
  cwd: string;
  active?: boolean;
}

export interface SessionCreationOptionsState {
  permissionMode: PermissionModeChoice;
  sessionMode: AdapterSessionMode;
  approvalPolicy: CodexApprovalPolicyChoice;
  codexSandbox: CodexSandboxChoice;
  claudeCodeSandbox: ClaudeSandboxChoice;
  grokSandbox: GrokSandboxChoice;
  provider: string;
  model: string;
  thinking: SessionThinkingChoice;
  setPermissionMode: (value: PermissionModeChoice) => void;
  setSessionMode: (value: AdapterSessionMode) => void;
  setApprovalPolicy: (value: CodexApprovalPolicyChoice) => void;
  setCodexSandbox: (value: CodexSandboxChoice) => void;
  setClaudeCodeSandbox: (value: ClaudeSandboxChoice) => void;
  setGrokSandbox: (value: GrokSandboxChoice) => void;
  setProvider: (value: string) => void;
  setModel: (value: string) => void;
  setThinking: (value: SessionThinkingChoice) => void;
}

const SAFE_FALLBACK: SessionCreationDefaults = {
  provider: '',
  model: '',
  thinking: 'high',
  permissionMode: 'bypassPermissions',
  sessionMode: 'default',
  approvalPolicy: 'on-request',
  codexSandbox: 'workspace-write',
  claudeCodeSandbox: 'workspace-write',
  grokSandbox: 'workspace',
};

/** Shared concrete defaults and same-process last-used memory for new-session dialogs. */
export function useSessionCreationOptions({
  adapterId,
  cwd,
  active = true,
}: Options): SessionCreationOptionsState {
  const initial = mergeRemembered(adapterId, fallbackForAdapter(adapterId));
  const [permissionMode, setPermissionModeState] = useState(initial.permissionMode);
  const [sessionMode, setSessionModeState] = useState(initial.sessionMode);
  const [approvalPolicy, setApprovalPolicyState] = useState(initial.approvalPolicy);
  const [codexSandbox, setCodexSandboxState] = useState(initial.codexSandbox);
  const [claudeCodeSandbox, setClaudeCodeSandboxState] = useState(
    initial.claudeCodeSandbox,
  );
  const [grokSandbox, setGrokSandboxState] = useState(initial.grokSandbox);
  const [provider, setProviderState] = useState(initial.provider);
  const [model, setModelState] = useState(initial.model);
  const [thinking, setThinkingState] = useState<SessionThinkingChoice>(initial.thinking);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const defaultsRequestGeneration = useRef(0);

  useEffect(() => {
    if (!active) return;
    applyState(mergeRemembered(adapterId, fallbackForAdapter(adapterId)));
    // Adapter changes should update the visible controls immediately. Cwd edits deliberately
    // keep the current values in place until the debounced native-config lookup completes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, adapterId]);

  useEffect(() => {
    const generation = ++defaultsRequestGeneration.current;
    if (!active || typeof window.api.getAdapterSessionCreationDefaults !== 'function') {
      return;
    }
    const timer = window.setTimeout(() => {
      const remembered = getLastDefaults(adapterId);
      void window.api
        .getAdapterSessionCreationDefaults(adapterId, {
          ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
          ...(remembered.provider ? { provider: remembered.provider } : {}),
        })
        .then((resolved) => {
          if (defaultsRequestGeneration.current === generation) {
            applyState(mergeRemembered(adapterId, resolved));
          }
        })
        .catch(() => {
          // Defaults are convenience UI metadata. Session creation still validates natively.
        });
    }, 120);

    return () => {
      if (defaultsRequestGeneration.current === generation) {
        defaultsRequestGeneration.current += 1;
      }
      window.clearTimeout(timer);
    };
    // selectionRevision is incremented when provider changes so its config is re-resolved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, adapterId, cwd, selectionRevision]);

  function applyState(next: SessionCreationDefaults): void {
    setPermissionModeState(next.permissionMode);
    setSessionModeState(next.sessionMode);
    setApprovalPolicyState(next.approvalPolicy);
    setCodexSandboxState(next.codexSandbox);
    setClaudeCodeSandboxState(next.claudeCodeSandbox);
    setGrokSandboxState(next.grokSandbox);
    setProviderState(next.provider);
    setModelState(next.model);
    setThinkingState(next.thinking);
  }

  return {
    permissionMode,
    sessionMode,
    approvalPolicy,
    codexSandbox,
    claudeCodeSandbox,
    grokSandbox,
    provider,
    model,
    thinking,
    setPermissionMode: (value) => {
      setPermissionModeState(value);
      setLastDefaults(adapterId, { permissionMode: value });
    },
    setSessionMode: (value) => {
      setSessionModeState(value);
      setLastDefaults(adapterId, { sessionMode: value });
    },
    setApprovalPolicy: (value) => {
      setApprovalPolicyState(value);
      setLastDefaults(adapterId, { approvalPolicy: value });
    },
    setCodexSandbox: (value) => {
      setCodexSandboxState(value);
      setLastDefaults(adapterId, { codexSandbox: value });
    },
    setClaudeCodeSandbox: (value) => {
      setClaudeCodeSandboxState(value);
      setLastDefaults(adapterId, { claudeCodeSandbox: value });
    },
    setGrokSandbox: (value) => {
      setGrokSandboxState(value);
      setLastDefaults(adapterId, { grokSandbox: value });
    },
    setProvider: (value) => {
      setProviderState(value);
      setModelState('');
      setLastDefaults(adapterId, { provider: value, model: '' });
      setSelectionRevision((current) => current + 1);
    },
    setModel: (value) => {
      setModelState(value);
      setLastDefaults(adapterId, { model: value });
    },
    setThinking: (value) => {
      if (!value) return;
      setThinkingState(value);
      setLastDefaults(adapterId, { thinking: value });
    },
  };
}

function mergeRemembered(
  adapterId: string,
  resolved: SessionCreationDefaults,
): SessionCreationDefaults {
  const remembered = getLastDefaults(adapterId);
  return {
    ...resolved,
    ...(remembered.permissionMode ? { permissionMode: remembered.permissionMode } : {}),
    ...(remembered.sessionMode ? { sessionMode: remembered.sessionMode } : {}),
    ...(remembered.approvalPolicy ? { approvalPolicy: remembered.approvalPolicy } : {}),
    ...(remembered.codexSandbox ? { codexSandbox: remembered.codexSandbox } : {}),
    ...(remembered.claudeCodeSandbox
      ? { claudeCodeSandbox: remembered.claudeCodeSandbox }
      : {}),
    ...(remembered.grokSandbox?.trim()
      ? { grokSandbox: remembered.grokSandbox.trim() }
      : {}),
    ...(remembered.provider?.trim() ? { provider: remembered.provider.trim() } : {}),
    ...(remembered.model?.trim() ? { model: remembered.model.trim() } : {}),
    ...(remembered.thinking ? { thinking: remembered.thinking } : {}),
  };
}

function fallbackForAdapter(adapterId: string): SessionCreationDefaults {
  if (adapterId === 'claude-code') return { ...SAFE_FALLBACK, model: 'sonnet' };
  if (adapterId === 'grok-build') return { ...SAFE_FALLBACK, model: 'grok-4.5' };
  return { ...SAFE_FALLBACK };
}
