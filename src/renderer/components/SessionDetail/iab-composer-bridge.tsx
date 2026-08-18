import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react';

export type IabAttachmentStatus = 'loading' | 'supported' | 'unsupported';

export interface IabComposerTarget {
  readonly key: string;
  readonly status: IabAttachmentStatus;
  readonly reason: string;
  readonly addPng?: (file: File) => Promise<boolean>;
}

interface RegisteredTarget {
  readonly token: symbol;
  readonly target: IabComposerTarget;
}

interface IabComposerBridgeValue {
  readonly target: IabComposerTarget;
  register(target: IabComposerTarget): () => void;
}

const DEFAULT_TARGET: IabComposerTarget = Object.freeze({
  key: 'unbound',
  status: 'loading',
  reason: '正在读取当前会话的图片输入能力…',
});

const IabComposerBridgeContext = createContext<IabComposerBridgeValue>({
  target: DEFAULT_TARGET,
  register: () => () => undefined,
});

export function IabComposerBridgeProvider({
  children,
  fallback = DEFAULT_TARGET,
}: {
  children: ReactNode;
  fallback?: IabComposerTarget;
}): JSX.Element {
  const [registered, setRegistered] = useState<RegisteredTarget | null>(null);
  const register = useCallback((target: IabComposerTarget): (() => void) => {
    const token = Symbol(target.key);
    setRegistered({ token, target });
    return () => setRegistered((current) => current?.token === token ? null : current);
  }, []);
  const value = useMemo<IabComposerBridgeValue>(() => ({
    target: registered?.target ?? fallback,
    register,
  }), [fallback, register, registered]);
  return (
    <IabComposerBridgeContext.Provider value={value}>
      {children}
    </IabComposerBridgeContext.Provider>
  );
}

export function useIabComposerTarget(): IabComposerTarget {
  return useContext(IabComposerBridgeContext).target;
}

export function useRegisterIabComposerTarget(target: IabComposerTarget): void {
  const bridge = useContext(IabComposerBridgeContext);
  useEffect(() => bridge.register(target), [bridge.register, target]);
}

export function unsupportedIabComposerTarget(
  key: string,
  reason: string,
): IabComposerTarget {
  return Object.freeze({ key, status: 'unsupported', reason });
}
