import {
  createCodexInstancePoolStore,
  type DisposableCodexInstance,
} from './instance-pool-store';

export interface CodexInstancePoolClientOptions {
  codexPathOverride: string | null;
  config: null;
  env: Record<string, string>;
}

export interface CodexInstancePoolHost<T extends DisposableCodexInstance> {
  createClient(options: CodexInstancePoolClientOptions): T;
  readCodexCliPath(): string | null | undefined;
  snapshotProcessEnv(): Record<string, string>;
}

export interface CodexInstancePool<T extends DisposableCodexInstance> {
  get(): T;
  invalidate(): void;
}

/** Compose the reusable oneshot client without discovering desktop settings or process state. */
export function createCodexInstancePool<T extends DisposableCodexInstance>(
  host: CodexInstancePoolHost<T>,
): CodexInstancePool<T> {
  const store = createCodexInstancePoolStore((codexPathOverride) =>
    host.createClient({
      codexPathOverride,
      config: null,
      env: {
        ...host.snapshotProcessEnv(),
        AGENT_DECK_ORIGIN: 'sdk',
      },
    }),
  );

  return {
    get: () => store.get(host.readCodexCliPath()),
    invalidate: store.invalidate,
  };
}
