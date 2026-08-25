import { useEffect, useRef, useState } from 'react';
import type {
  AdapterSessionMode,
  ProjectTrustDescriptor,
  ProjectTrustRequest,
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
  /** Exact authoring/open cycle. A new scope never reuses an earlier settled projection. */
  scopeKey?: string;
}

export interface SessionCreationOptionsState {
  /** The model/provider defaults are being resolved for the current adapter and cwd. */
  defaultsLoading: boolean;
  /** All readiness-required configuration reads for the current form projection. */
  configurationLoading: boolean;
  providerOptions: readonly { id: string; name?: string }[];
  permissionMode: PermissionModeChoice;
  sessionMode: AdapterSessionMode;
  approvalPolicy: CodexApprovalPolicyChoice;
  codexSandbox: CodexSandboxChoice;
  claudeCodeSandbox: ClaudeSandboxChoice;
  grokSandbox: GrokSandboxChoice;
  provider: string;
  model: string;
  thinking: SessionThinkingChoice;
  projectTrust: ProjectTrustDescriptor;
  /**
   * Last settled trust descriptor that is safe to present while a same-adapter refresh is pending.
   * A new adapter has no placeholder descriptor, so unresolved trust is never rendered as a
   * terminal "provider unavailable" diagnosis during the shared 150 ms readiness transition.
   */
  projectTrustPresentation: ProjectTrustDescriptor | null;
  projectTrustGrant: boolean;
  projectTrustRequest: ProjectTrustRequest | null;
  setPermissionMode: (value: PermissionModeChoice) => void;
  setSessionMode: (value: AdapterSessionMode) => void;
  setApprovalPolicy: (value: CodexApprovalPolicyChoice) => void;
  setCodexSandbox: (value: CodexSandboxChoice) => void;
  setClaudeCodeSandbox: (value: ClaudeSandboxChoice) => void;
  setGrokSandbox: (value: GrokSandboxChoice) => void;
  setProvider: (value: string) => void;
  setModel: (value: string) => void;
  setThinking: (value: SessionThinkingChoice) => void;
  setProjectTrustGrant: (value: boolean) => void;
}

const SAFE_FALLBACK: SessionCreationDefaults = {
  provider: '',
  model: '',
  thinking: 'high',
  permissionMode: 'bypassPermissions',
  sessionMode: 'default',
  approvalPolicy: 'never',
  codexSandbox: 'workspace-write',
  claudeCodeSandbox: 'workspace-write',
  grokSandbox: 'workspace',
};

interface SelectionState {
  identity: string;
  value: SessionCreationDefaults;
  projectTrust: ProjectTrustDescriptor;
  trustAuthoritative: boolean;
}

const UNAVAILABLE_PROJECT_TRUST: ProjectTrustDescriptor = Object.freeze({
  status: 'unknown',
  canGrant: false,
  reasonCode: 'provider-unavailable',
  revision: `sha256:${'0'.repeat(64)}`,
});

interface TrustSelection {
  requestKey: string;
  grant: boolean;
}

interface ProviderCatalogState {
  key: string;
  options: readonly { id: string; name?: string }[];
}

/** Shared concrete defaults and same-process last-used memory for new-session dialogs. */
export function useSessionCreationOptions({
  adapterId,
  cwd,
  active = true,
  scopeKey = 'session-creation',
}: Options): SessionCreationOptionsState {
  const initial = mergeRemembered(adapterId, fallbackForAdapter(adapterId));
  const selectionIdentity = `${scopeKey}\u0000${adapterId}`;
  const [selection, setSelection] = useState<SelectionState>({
    identity: selectionIdentity,
    value: initial,
    projectTrust: UNAVAILABLE_PROJECT_TRUST,
    trustAuthoritative: false,
  });
  const [trustSelection, setTrustSelection] = useState<TrustSelection>({
    requestKey: '',
    grant: false,
  });
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [resolvedRequestKey, setResolvedRequestKey] = useState<string | null>(null);
  const [providerCatalog, setProviderCatalog] = useState<ProviderCatalogState>({
    key: '',
    options: [],
  });
  const defaultsRequestGeneration = useRef(0);
  const providerCatalogGeneration = useRef(0);
  const resolvedSelectionIdentity = useRef<string | null>(null);
  const requestKey = `${scopeKey}\u0000${adapterId}\u0000${cwd.trim()}\u0000${selectionRevision}`;
  const current = selection.identity === selectionIdentity
    ? selection.value
    : initial;
  const supportsProviderCatalog = adapterId === 'claude-code' || adapterId === 'codex-cli';
  const providerCatalogKey = `${scopeKey}\u0000${adapterId}`;

  useEffect(() => {
    const generation = ++defaultsRequestGeneration.current;
    if (!active) {
      resolvedSelectionIdentity.current = null;
      setResolvedRequestKey(null);
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
            setSelection({
              identity: selectionIdentity,
              value: mergeRemembered(adapterId, resolved),
              projectTrust: resolved.projectTrust ?? UNAVAILABLE_PROJECT_TRUST,
              trustAuthoritative: resolved.projectTrust !== undefined,
            });
            setTrustSelection({ requestKey, grant: false });
            resolvedSelectionIdentity.current = selectionIdentity;
            setResolvedRequestKey(requestKey);
          }
        })
        .catch(() => {
          // Defaults are convenience UI metadata. Session creation still validates natively.
          if (defaultsRequestGeneration.current === generation) {
            // Do not carry a cwd-derived projection into another cwd after its lookup fails.
            // Explicit last-used choices survive through mergeRemembered; derived values reset.
            setSelection({
              identity: selectionIdentity,
              value: mergeRemembered(adapterId, fallbackForAdapter(adapterId)),
              projectTrust: UNAVAILABLE_PROJECT_TRUST,
              trustAuthoritative: false,
            });
            setTrustSelection({ requestKey, grant: false });
            resolvedSelectionIdentity.current = selectionIdentity;
            setResolvedRequestKey(requestKey);
          }
        });
    }, resolvedSelectionIdentity.current === selectionIdentity ? 120 : 0);

    return () => {
      if (defaultsRequestGeneration.current === generation) {
        defaultsRequestGeneration.current += 1;
      }
      window.clearTimeout(timer);
    };
    // selectionRevision is incremented when provider changes so its config is re-resolved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, adapterId, cwd, scopeKey, selectionIdentity, selectionRevision]);

  useEffect(() => {
    const generation = ++providerCatalogGeneration.current;
    if (!active || !supportsProviderCatalog) return;
    const request = adapterId === 'claude-code'
      ? window.api.listClaudeGatewayProfiles()
      : window.api.listCodexGatewayProfiles();
    void request.then((options) => {
      if (providerCatalogGeneration.current === generation) {
        setProviderCatalog({ key: providerCatalogKey, options });
      }
    }).catch(() => {
      if (providerCatalogGeneration.current === generation) {
        // Discovery is convenience metadata. An empty, settled catalog retains free-text input.
        setProviderCatalog({ key: providerCatalogKey, options: [] });
      }
    });
    return () => {
      if (providerCatalogGeneration.current === generation) {
        providerCatalogGeneration.current += 1;
      }
    };
  }, [
    active,
    adapterId,
    providerCatalogKey,
    supportsProviderCatalog,
  ]);

  const defaultsLoading = active && resolvedRequestKey !== requestKey;
  const providerOptionsLoading = active && supportsProviderCatalog &&
    providerCatalog.key !== providerCatalogKey;
  const providerOptions = supportsProviderCatalog && providerCatalog.key === providerCatalogKey
    ? providerCatalog.options
    : [];
  const projectTrust = selection.identity === selectionIdentity && resolvedRequestKey === requestKey
    ? selection.projectTrust
    : UNAVAILABLE_PROJECT_TRUST;
  const projectTrustPresentation = resolvedRequestKey === requestKey
    ? projectTrust
    : selection.identity === selectionIdentity && selection.trustAuthoritative
      ? selection.projectTrust
      : null;
  const projectTrustGrant = trustSelection.requestKey === requestKey && trustSelection.grant;

  const patchSelection = (patch: Partial<SessionCreationDefaults>): void => {
    setSelection((previous) => ({
      identity: selectionIdentity,
      value: {
        ...(previous.identity === selectionIdentity ? previous.value : initial),
        ...patch,
      },
      projectTrust: previous.identity === selectionIdentity
        ? previous.projectTrust
        : UNAVAILABLE_PROJECT_TRUST,
      trustAuthoritative: previous.identity === selectionIdentity && previous.trustAuthoritative,
    }));
  };

  return {
    defaultsLoading,
    configurationLoading: defaultsLoading || providerOptionsLoading,
    providerOptions,
    permissionMode: current.permissionMode,
    sessionMode: current.sessionMode,
    approvalPolicy: current.approvalPolicy,
    codexSandbox: current.codexSandbox,
    claudeCodeSandbox: current.claudeCodeSandbox,
    grokSandbox: current.grokSandbox,
    provider: current.provider,
    model: current.model,
    thinking: current.thinking as SessionThinkingChoice,
    projectTrust,
    projectTrustPresentation,
    projectTrustGrant,
    projectTrustRequest: selection.trustAuthoritative && resolvedRequestKey === requestKey
      ? { revision: projectTrust.revision, grant: projectTrustGrant }
      : null,
    setPermissionMode: (value) => {
      patchSelection({ permissionMode: value });
      setLastDefaults(adapterId, { permissionMode: value });
    },
    setSessionMode: (value) => {
      patchSelection({ sessionMode: value });
      setLastDefaults(adapterId, { sessionMode: value });
    },
    setApprovalPolicy: (value) => {
      patchSelection({ approvalPolicy: value });
      setLastDefaults(adapterId, { approvalPolicy: value });
    },
    setCodexSandbox: (value) => {
      patchSelection({ codexSandbox: value });
      setLastDefaults(adapterId, { codexSandbox: value });
    },
    setClaudeCodeSandbox: (value) => {
      patchSelection({ claudeCodeSandbox: value });
      setLastDefaults(adapterId, { claudeCodeSandbox: value });
    },
    setGrokSandbox: (value) => {
      patchSelection({ grokSandbox: value });
      setLastDefaults(adapterId, { grokSandbox: value });
    },
    setProvider: (value) => {
      patchSelection({ provider: value, model: '' });
      setLastDefaults(adapterId, { provider: value, model: '' });
      setSelectionRevision((current) => current + 1);
      setTrustSelection({ requestKey: '', grant: false });
    },
    setModel: (value) => {
      patchSelection({ model: value });
      setLastDefaults(adapterId, { model: value });
    },
    setThinking: (value) => {
      if (!value) return;
      patchSelection({ thinking: value });
      setLastDefaults(adapterId, { thinking: value });
    },
    setProjectTrustGrant: (value) => {
      if (!projectTrust.canGrant) return;
      setTrustSelection({ requestKey, grant: value });
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
