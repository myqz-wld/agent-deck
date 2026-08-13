import { useEffect, useRef, useState } from 'react';

import {
  SESSION_CONSOLE_CREATE_OPTION_KEYS,
  type SessionConsoleCapabilitiesResult,
  type SessionConsoleAdapterSummaryDescriptor,
  type SessionConsoleCreateOptionDescriptor,
  type SessionConsoleCreateOptionKey,
  type SessionConsoleCreateOptions,
} from '@contracts/index';
import type { RemoteSessionSourceView } from '@renderer/remote-host/source-types';

const EMPTY_OPTIONS: SessionConsoleCreateOptions = Object.freeze({
  approvalPolicy: null,
  claudeCodeSandbox: null,
  codexSandbox: null,
  grokSandbox: null,
  model: null,
  permissionMode: null,
  provider: null,
  sessionMode: null,
  thinking: null,
});

interface Input {
  active: boolean;
  /** Exact dialog/issue authoring cycle. */
  scopeKey: string;
  source: RemoteSessionSourceView | null;
  workingDirectory: string;
}

interface AuthoringState {
  scopeKey: string;
  adapterId: string;
  options: SessionConsoleCreateOptions;
  overrides: readonly SessionConsoleCreateOptionKey[];
}

interface CapabilitySnapshot {
  scopeKey: string;
  requestKey: string;
  adapterId: string;
  options: SessionConsoleCreateOptions;
  descriptor: SessionConsoleCapabilitiesResult;
}

interface RequestFailure {
  requestKey: string;
  message: string;
}

export interface RemoteSessionCreationState {
  /** Exact source/availability cycle used to reset first-load presentation safely. */
  readinessIdentity: string;
  adapterId: string;
  adapters: readonly SessionConsoleAdapterSummaryDescriptor[];
  /** Exact descriptor authorized for submission; null while the current request is unresolved. */
  descriptor: SessionConsoleCapabilitiesResult | null;
  /** Last complete descriptor retained only to keep the form shape stable. */
  presentationDescriptor: SessionConsoleCapabilitiesResult | null;
  /** Adapter and values belonging to the stable presentation while another adapter resolves. */
  presentationAdapterId: string;
  presentationOptions: SessionConsoleCreateOptions;
  error: string | null;
  /** True until the first complete descriptor or terminal error for this authoring scope. */
  initializing: boolean;
  /** Includes the debounce window and the in-flight capability read. */
  loading: boolean;
  options: SessionConsoleCreateOptions;
  ready: boolean;
  retry(): void;
  setAdapterId(value: string): void;
  setOption(key: SessionConsoleCreateOptionKey, value: string): void;
}

function descriptorDefaults(
  descriptor: SessionConsoleCapabilitiesResult,
): SessionConsoleCreateOptions {
  return Object.fromEntries(SESSION_CONSOLE_CREATE_OPTION_KEYS.map((key) => [
    key,
    descriptor.create.options[key].defaultValue,
  ])) as unknown as SessionConsoleCreateOptions;
}

function emptyAuthoring(scopeKey: string): AuthoringState {
  return { scopeKey, adapterId: '', options: EMPTY_OPTIONS, overrides: [] };
}

function normalizeWorkingDirectory(value: string): string {
  return value.trim() || '.';
}

function capabilityRequestKey(
  scopeKey: string,
  adapterId: string,
  provider: string,
  workingDirectory: string,
): string {
  return `${scopeKey}\u0000${adapterId}\u0000${provider}\u0000${workingDirectory}`;
}

function acceptsValue(
  schema: SessionConsoleCreateOptionDescriptor,
  value: string | null,
): boolean {
  if (!schema.enabled) return value === null;
  if (value === null) return false;
  if (value.length === 0) return schema.allowEmpty;
  if (schema.allowedValues?.includes(value)) return true;
  return schema.allowCustom;
}

/** Preserve only explicit, still-valid author choices across directory/provider revalidation. */
function reconcileOptions(
  current: AuthoringState,
  descriptor: SessionConsoleCapabilitiesResult,
): SessionConsoleCreateOptions {
  const next = descriptorDefaults(descriptor);
  const overrides = new Set(current.overrides);
  for (const key of SESSION_CONSOLE_CREATE_OPTION_KEYS) {
    if (!overrides.has(key)) continue;
    const value = current.options[key];
    if (acceptsValue(descriptor.create.options[key], value)) next[key] = value;
  }
  return next;
}

export function useRemoteSessionCreation({
  active,
  scopeKey: requestedScopeKey,
  source,
  workingDirectory,
}: Input): RemoteSessionCreationState {
  const sourceIdentity = source?.identity ?? 'no-remote-source';
  const canRead = source?.usable === true &&
    source.capabilities.has('session-console.read');
  const authoritySignature = `${sourceIdentity}\u0000${active ? 'active' : 'inactive'}` +
    `\u0000${canRead ? 'ready' : 'unavailable'}`;
  const authorityCycle = useRef({ signature: authoritySignature, value: 0 });
  if (authorityCycle.current.signature !== authoritySignature) {
    authorityCycle.current = {
      signature: authoritySignature,
      value: authorityCycle.current.value + 1,
    };
  }
  const scopeKey = `${requestedScopeKey}\u0000${sourceIdentity}\u0000${authorityCycle.current.value}`;
  const [authoringState, setAuthoringState] = useState<AuthoringState>(
    () => emptyAuthoring(scopeKey),
  );
  const [snapshot, setSnapshot] = useState<CapabilitySnapshot | null>(null);
  const [failure, setFailure] = useState<RequestFailure | null>(null);
  const [requestRevision, setRequestRevision] = useState(0);
  const generation = useRef(0);
  const settledScope = useRef<string | null>(null);
  const authoring = authoringState.scopeKey === scopeKey
    ? authoringState
    : emptyAuthoring(scopeKey);
  const provider = authoring.options.provider ?? '';
  const normalizedDirectory = normalizeWorkingDirectory(workingDirectory);
  const requestKey = capabilityRequestKey(
    scopeKey,
    authoring.adapterId,
    provider,
    normalizedDirectory,
  );
  const sameScopeSnapshot = snapshot?.scopeKey === scopeKey ? snapshot : null;
  const presentationDescriptor = sameScopeSnapshot?.descriptor ?? null;
  const descriptor = sameScopeSnapshot?.requestKey === requestKey
    ? sameScopeSnapshot.descriptor
    : null;
  const presentCommittedAdapter = Boolean(
    sameScopeSnapshot && !descriptor && sameScopeSnapshot.adapterId !== authoring.adapterId,
  );
  const presentationAdapterId = presentCommittedAdapter
    ? sameScopeSnapshot!.adapterId
    : authoring.adapterId;
  const presentationOptions = presentCommittedAdapter
    ? sameScopeSnapshot!.options
    : authoring.options;
  const currentFailure = failure?.requestKey === requestKey ? failure : null;
  const loading = Boolean(active && source && canRead && !descriptor && !currentFailure);
  const error = !active || !source
    ? null
    : !canRead
      ? '当前远程 Core 未提供会话创建配置。'
      : currentFailure?.message ?? null;

  useEffect(() => {
    const currentGeneration = ++generation.current;
    if (!active || !source || !canRead) return;
    const requestAdapterId = authoring.adapterId || null;
    const requestProvider = provider;
    const requestDirectory = normalizedDirectory;
    setFailure((current) => current?.requestKey === requestKey ? null : current);
    const timer = window.setTimeout(() => {
      void source.getSessionCapabilities({
        adapterId: requestAdapterId,
        provider: requestProvider,
        workingDirectory: requestDirectory,
      }).then((result) => {
        if (generation.current !== currentGeneration) return;
        const responseAuthoring = authoring.scopeKey === scopeKey && (
          authoring.adapterId.length === 0 || authoring.adapterId === result.selectedAdapterId
        )
          ? { ...authoring, adapterId: result.selectedAdapterId }
          : { ...emptyAuthoring(scopeKey), adapterId: result.selectedAdapterId };
        const committedOptions = reconcileOptions(responseAuthoring, result);
        const resolvedProvider = committedOptions.provider ?? '';
        const resolvedKey = capabilityRequestKey(
          scopeKey,
          result.selectedAdapterId,
          resolvedProvider,
          requestDirectory,
        );
        setAuthoringState({
          ...responseAuthoring,
          options: committedOptions,
        });
        setSnapshot({
          scopeKey,
          requestKey: resolvedKey,
          adapterId: result.selectedAdapterId,
          options: committedOptions,
          descriptor: result,
        });
        settledScope.current = scopeKey;
        setFailure(null);
      }).catch((reason: unknown) => {
        if (generation.current !== currentGeneration) return;
        settledScope.current = scopeKey;
        setFailure({
          requestKey,
          message: reason instanceof Error ? reason.message : String(reason),
        });
      });
    }, settledScope.current === scopeKey ? 120 : 0);
    return () => {
      if (generation.current === currentGeneration) generation.current += 1;
      window.clearTimeout(timer);
    };
    // Adapter/provider changes increment requestRevision. Depending on the whole source view-model
    // would restart capability reads after unrelated Remote state updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    active,
    canRead,
    normalizedDirectory,
    requestRevision,
    requestedScopeKey,
    sourceIdentity,
  ]);

  return {
    readinessIdentity: JSON.stringify([
      requestedScopeKey,
      sourceIdentity,
      authorityCycle.current.value,
    ]),
    adapterId: authoring.adapterId,
    adapters: canRead ? presentationDescriptor?.adapters ?? [] : [],
    descriptor: canRead ? descriptor : null,
    presentationDescriptor: canRead ? presentationDescriptor : null,
    presentationAdapterId: canRead ? presentationAdapterId : '',
    presentationOptions: canRead ? presentationOptions : EMPTY_OPTIONS,
    error,
    initializing: loading && presentationDescriptor === null,
    loading,
    options: authoring.options,
    ready: descriptor !== null,
    retry: () => {
      if (!active || !source || !canRead) return;
      generation.current += 1;
      settledScope.current = null;
      setFailure(null);
      setRequestRevision((current) => current + 1);
    },
    setAdapterId: (value) => {
      if (value === authoring.adapterId && descriptor) return;
      generation.current += 1;
      settledScope.current = scopeKey;
      setAuthoringState({
        ...emptyAuthoring(scopeKey),
        adapterId: value,
      });
      setFailure(null);
      setRequestRevision((current) => current + 1);
    },
    setOption: (key, value) => {
      const schema = presentationDescriptor?.create.options[key];
      if (!schema?.enabled) return;
      if (key === 'provider') generation.current += 1;
      setAuthoringState((current) => {
        const scoped = current.scopeKey === scopeKey ? current : authoring;
        const overrides = new Set(scoped.overrides);
        overrides.add(key);
        if (key === 'provider') overrides.delete('model');
        return {
          ...scoped,
          options: {
            ...scoped.options,
            [key]: value,
            ...(key === 'provider' ? { model: '' } : {}),
          },
          overrides: [...overrides],
        };
      });
      if (key === 'provider') {
        setFailure(null);
        setRequestRevision((current) => current + 1);
      }
    },
  };
}
