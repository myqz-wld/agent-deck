import type { ClaudeCodeAdapter } from './claude-code';
import type { CodexCliAdapter } from './codex-cli';
import type { GrokBuildAdapter } from './grok-build';
import type { CreateSessionOptionsByAdapter } from './options-builder';
import type { AgentAdapter, AdapterContext } from './types';

export type AdapterRegistryOperation = 'init' | 'shutdown';

export interface AdapterRegistryDiagnosticPort {
  begin(): number | null;
  observe(
    phase: AdapterRegistryOperation,
    totalCount: number,
    failedCount: number,
    startedAtMs: number | null,
  ): void;
}

export const NOOP_ADAPTER_REGISTRY_DIAGNOSTICS: AdapterRegistryDiagnosticPort = {
  begin: () => null,
  observe: () => undefined,
};

/** Compile-time ids map to concrete implementations without runtime adapter imports. */
export type AdapterIdMap = {
  'claude-code': ClaudeCodeAdapter;
  'codex-cli': CodexCliAdapter;
  'grok-build': GrokBuildAdapter;
};

export interface AdapterInitResult {
  id: string;
  ok: boolean;
  err?: unknown;
}

export interface AdapterShutdownResult {
  id: string;
  ok: boolean;
  err?: unknown;
}

type AssertSameKeys<A, B> = keyof A extends keyof B
  ? keyof B extends keyof A
    ? true
    : false
  : false;
const adapterIdsMatchOptions: AssertSameKeys<AdapterIdMap, CreateSessionOptionsByAdapter> = true;
void adapterIdsMatchOptions;

/** Provider lifecycle registry with diagnostics supplied by the owning host. */
export class AdapterRegistryClass {
  private readonly map = new Map<string, AgentAdapter>();
  private readonly ready = new Set<string>();

  constructor(
    private readonly diagnostics: AdapterRegistryDiagnosticPort =
      NOOP_ADAPTER_REGISTRY_DIAGNOSTICS,
  ) {}

  register(adapter: AgentAdapter): void {
    if (this.map.has(adapter.id)) {
      throw new Error(`Adapter ${adapter.id} already registered`);
    }
    this.map.set(adapter.id, adapter);
  }

  get(id: string): AgentAdapter | undefined {
    return this.map.get(id);
  }

  list(): AgentAdapter[] {
    return [...this.map.values()];
  }

  isReady(id: string): boolean {
    return this.ready.has(id);
  }

  async initAll(ctx: AdapterContext): Promise<AdapterInitResult[]> {
    const startedAtMs = this.diagnostics.begin();
    const results: AdapterInitResult[] = [];
    let failedCount = 0;
    for (const adapter of this.map.values()) {
      try {
        await adapter.init(ctx);
        this.ready.add(adapter.id);
        results.push({ id: adapter.id, ok: true });
      } catch (err) {
        this.ready.delete(adapter.id);
        failedCount += 1;
        results.push({ id: adapter.id, ok: false, err });
      }
    }
    this.diagnostics.observe('init', results.length, failedCount, startedAtMs);
    return results;
  }

  async shutdownAll(): Promise<AdapterShutdownResult[]> {
    const startedAtMs = this.diagnostics.begin();
    const results: AdapterShutdownResult[] = [];
    let failedCount = 0;
    for (const adapter of this.map.values()) {
      try {
        await adapter.shutdown();
        results.push({ id: adapter.id, ok: true });
      } catch (err) {
        failedCount += 1;
        results.push({ id: adapter.id, ok: false, err });
      }
    }
    this.ready.clear();
    this.diagnostics.observe('shutdown', results.length, failedCount, startedAtMs);
    return results;
  }
}
