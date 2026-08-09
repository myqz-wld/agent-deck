import { useEffect, useRef, useState } from 'react';

import {
  SESSION_CONSOLE_CREATE_OPTION_KEYS,
  type SessionConsoleCapabilitiesResult,
  type SessionConsoleAdapterSummaryDescriptor,
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
  source: RemoteSessionSourceView | null;
  workingDirectory: string;
}

export interface RemoteSessionCreationState {
  adapterId: string;
  adapters: readonly SessionConsoleAdapterSummaryDescriptor[];
  descriptor: SessionConsoleCapabilitiesResult | null;
  error: string | null;
  loading: boolean;
  options: SessionConsoleCreateOptions;
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

export function useRemoteSessionCreation({
  active,
  source,
  workingDirectory,
}: Input): RemoteSessionCreationState {
  const [adapterId, setAdapterIdState] = useState('');
  const [adapters, setAdapters] = useState<readonly SessionConsoleAdapterSummaryDescriptor[]>([]);
  const [descriptor, setDescriptor] = useState<SessionConsoleCapabilitiesResult | null>(null);
  const [options, setOptions] = useState<SessionConsoleCreateOptions>(EMPTY_OPTIONS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adapterRequestRevision, setAdapterRequestRevision] = useState(0);
  const generation = useRef(0);
  const requestedAdapterId = useRef<string | null>(null);
  const sourceIdentity = source?.identity ?? 'no-remote-source';
  const provider = options.provider ?? '';
  const canRead = source?.usable === true &&
    source.capabilities.has('session-console.read');

  useEffect(() => {
    generation.current += 1;
    requestedAdapterId.current = null;
    setAdapterIdState('');
    setAdapters([]);
    setDescriptor(null);
    setOptions(EMPTY_OPTIONS);
    setLoading(false);
    setError(null);
  }, [sourceIdentity]);

  useEffect(() => {
    const current = ++generation.current;
    if (!active || !source || !canRead) {
      setDescriptor(null);
      setLoading(false);
      if (active && source && !canRead) setError('当前远程 Core 未提供会话创建配置。');
      return;
    }
    setDescriptor(null);
    setLoading(true);
    setError(null);
    const adapterIdForRequest = requestedAdapterId.current;
    const timer = window.setTimeout(() => {
      void source.getSessionCapabilities({
        adapterId: adapterIdForRequest,
        provider,
        workingDirectory: workingDirectory.trim() || '.',
      }).then((result) => {
        if (generation.current !== current) return;
        requestedAdapterId.current = result.selectedAdapterId;
        setAdapterIdState(result.selectedAdapterId);
        setAdapters(result.adapters);
        setOptions(descriptorDefaults(result));
        setDescriptor(result);
        setLoading(false);
      }).catch((reason: unknown) => {
        if (generation.current !== current) return;
        setDescriptor(null);
        setLoading(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    }, 120);
    return () => window.clearTimeout(timer);
    // source methods are view-model actions qualified by sourceIdentity; depending on the whole
    // render object would restart this request after every unrelated remote state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, adapterRequestRevision, canRead, provider, sourceIdentity, workingDirectory]);

  return {
    adapterId,
    adapters,
    descriptor,
    error,
    loading,
    options,
    setAdapterId: (value) => {
      if (value === adapterId) return;
      generation.current += 1;
      requestedAdapterId.current = value;
      setAdapterIdState(value);
      setAdapterRequestRevision((current) => current + 1);
      setOptions(EMPTY_OPTIONS);
      setDescriptor(null);
      setError(null);
    },
    setOption: (key, value) => {
      const schema = descriptor?.create.options[key];
      if (!schema?.enabled) return;
      generation.current += key === 'provider' ? 1 : 0;
      setOptions((current) => ({
        ...current,
        [key]: value,
        ...(key === 'provider' ? { model: '' } : {}),
      }));
      if (key === 'provider') {
        setDescriptor(null);
        setLoading(true);
        setError(null);
      }
    },
  };
}
