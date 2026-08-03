import type { CodexConfigObject } from '@main/codex-config/agent-deck-mcp-injector';
import type { ContextRuntimeIdentityEvidence } from '@shared/types';
import type { CodexThreadOptions } from '../sdk-bridge/thread-options-builder';
import type { CodexAppServerClient } from './client';
import type { CodexAppServerNotification } from './protocol';
import { getNotificationThreadId } from './notification-helpers';
import { buildThreadConfig } from './thread-params';

export class CodexRuntimeIdentityTracker {
  private current: ContextRuntimeIdentityEvidence | null;

  constructor(
    private readonly baseConfig: CodexConfigObject | null,
    options: CodexThreadOptions,
    initialRuntime?: unknown,
  ) {
    this.current = initialRuntime === undefined
      ? null
      : resolveCodexThreadRuntimeIdentity(initialRuntime, options, baseConfig);
  }

  snapshot(): ContextRuntimeIdentityEvidence | null {
    return cloneCodexRuntimeIdentity(this.current);
  }

  observeThreadBoundary(response: unknown, options: CodexThreadOptions): void {
    this.current = resolveCodexThreadRuntimeIdentity(response, options, this.baseConfig);
  }

  observeNotification(notification: CodexAppServerNotification): void {
    this.current = applyCodexRuntimeIdentityNotification(this.current, notification);
  }

  async updateModelSettings(
    client: CodexAppServerClient,
    threadId: string,
    options: CodexThreadOptions,
    model: CodexThreadOptions['model'] | null,
    effort: CodexThreadOptions['modelReasoningEffort'] | null,
  ): Promise<void> {
    const previous = this.current;
    const fingerprint = resolveCodexCapacityConfigFingerprint(options, this.baseConfig);
    let observed: ContextRuntimeIdentityEvidence | null = null;
    const unsubscribe = client.subscribe((notification) => {
      if (
        notification.method !== 'thread/settings/updated' ||
        getNotificationThreadId(notification) !== threadId
      ) return;
      observed = applyCodexRuntimeIdentityNotification(
        null,
        notification,
        fingerprint ?? undefined,
      );
    });
    this.current = null;
    try {
      await client.request('thread/settings/update', { threadId, model, effort });
    } catch (error) {
      this.current = previous;
      throw error;
    } finally {
      unsubscribe();
    }
    this.current = observed;
  }
}

export function resolveCodexThreadRuntimeIdentity(
  response: unknown,
  options: CodexThreadOptions,
  baseConfig: CodexConfigObject | null,
): ContextRuntimeIdentityEvidence | null {
  const record = asRecord(response);
  const thread = asRecord(record?.thread);
  const model = nonBlank(record?.model);
  const runtimeProvider =
    nonBlank(record?.modelProvider) ?? nonBlank(thread?.modelProvider);
  if (!model || !runtimeProvider) return null;
  const capacityConfigFingerprint = resolveCodexCapacityConfigFingerprint(options, baseConfig);
  return {
    runtimeProvider,
    model,
    ...(capacityConfigFingerprint ? { capacityConfigFingerprint } : {}),
  };
}

/** Apply only native runtime-setting/model-reroute notifications; unrelated events preserve state. */
export function applyCodexRuntimeIdentityNotification(
  current: ContextRuntimeIdentityEvidence | null,
  notification: CodexAppServerNotification,
  capacityConfigFingerprint = current?.capacityConfigFingerprint,
): ContextRuntimeIdentityEvidence | null {
  const params = asRecord(notification.params);
  if (notification.method === 'thread/settings/updated') {
    const settings = asRecord(params?.threadSettings);
    const model = nonBlank(settings?.model);
    const runtimeProvider = nonBlank(settings?.modelProvider);
    if (!model || !runtimeProvider) return null;
    return {
      runtimeProvider,
      model,
      ...(capacityConfigFingerprint
        ? { capacityConfigFingerprint }
        : {}),
    };
  }
  if (notification.method === 'model/rerouted') {
    const model = nonBlank(params?.toModel);
    if (!model || !current) return null;
    return { ...current, model };
  }
  return current;
}

export function cloneCodexRuntimeIdentity(
  identity: ContextRuntimeIdentityEvidence | null,
): ContextRuntimeIdentityEvidence | null {
  return identity ? { ...identity } : null;
}

export function resolveCodexCapacityConfigFingerprint(
  options: CodexThreadOptions,
  baseConfig: CodexConfigObject | null,
): string | null {
  return resolveCodexCapacityConfigFingerprintFromConfig(
    buildThreadConfig(options, baseConfig),
  );
}

/** Rebuild the capacity-affecting identity component from the exact config sent to app-server. */
export function resolveCodexCapacityConfigFingerprintFromConfig(
  config: Record<string, unknown> | null | undefined,
): string | null {
  const configured = config?.model_context_window;
  if (
    typeof configured !== 'number' ||
    !Number.isSafeInteger(configured) ||
    configured <= 0
  ) return null;
  return `model-context-window:${configured}`;
}

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
