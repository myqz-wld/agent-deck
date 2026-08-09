import {
  PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION,
  parseProviderSessionAttachSpec,
  parseProviderSessionLaunchResult,
  parseProviderSessionLaunchSpec,
  parseProviderSessionStopResult,
  parseProviderSessionStopSpec,
  parseProviderSessionSupervisorCapabilities,
  type ProviderSessionLaunchResult,
  type ProviderSessionLaunchSpec,
  type ProviderSessionAttachSpec,
  type ProviderSessionStopResult,
  type ProviderSessionStopSpec,
  type ProviderSessionSupervisorCapabilities,
} from '@contracts/index';

import {
  assertProviderSessionOciInspection,
  buildProviderSessionOciPlan,
} from './oci-command';
import {
  ProviderSessionSupervisorError,
  type ProviderSessionControlChannel,
  type ProviderSessionSupervisorControlPort,
} from './supervisor-port';
import {
  PROVIDER_SESSION_MAX_ACTIVE_CONTAINERS,
  availableProviderSessionAdapters,
  type ProviderSessionHostMountBinding,
  type ProviderSessionHostMountPort,
  type ProviderSessionImageCatalog,
  type ProviderSessionOciBoundary,
  type ProviderSessionOciEngine,
  type ProviderSessionOciInspection,
  type ProviderSessionOciAttachment,
  type ProviderSessionOciPlan,
  type ProviderSessionOciPort,
} from './types';

const UNAVAILABLE_REASON = 'Provider session isolation is unavailable.';
const CREATE_RECONCILE_ATTEMPTS = 4;
const defaultCreateReconcileDelay = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 250));

export interface ProviderSessionContainerSupervisorOptions {
  readonly coreProcessId: string;
  readonly engine: ProviderSessionOciEngine;
  readonly executable: string;
  readonly images: ProviderSessionImageCatalog;
  readonly instanceId: string;
  readonly maxActive?: number;
  readonly mounts: ProviderSessionHostMountPort;
  readonly oci: ProviderSessionOciPort;
  readonly createReconcileDelay?: () => Promise<void>;
  readonly runtimeUser: {
    readonly gid: number;
    readonly uid: number;
  };
}

interface ProviderSessionLease {
  readonly mount: ProviderSessionHostMountBinding;
  readonly plan: ProviderSessionOciPlan;
  readonly runtimeHandle: string;
  readonly spec: ProviderSessionLaunchSpec;
}

interface ProviderSessionPendingTeardown {
  readonly expectedHandle?: string;
  readonly mount: ProviderSessionHostMountBinding;
  readonly plan: ProviderSessionOciPlan | null;
  readonly unresolvedCreate?: boolean;
}

function expectedBoundary(engine: ProviderSessionOciEngine): ProviderSessionOciBoundary {
  return engine === 'rootless-podman' ? 'rootless-user' : 'desktop-vm';
}

function error(code: ConstructorParameters<typeof ProviderSessionSupervisorError>[0], message: string) {
  return new ProviderSessionSupervisorError(code, message);
}

/**
 * Host-owned lifecycle fence. Core supplies only the exact public launch DTO; mounts, images,
 * engine selection, commands, and destructive container identities remain host configuration.
 */
export class ProviderSessionContainerSupervisor implements ProviderSessionSupervisorControlPort {
  private readonly images: ProviderSessionImageCatalog;
  private readonly maxActive: number;
  private readonly leasesByProcess = new Map<string, ProviderSessionLease>();
  private readonly leasesBySession = new Map<string, ProviderSessionLease>();
  private readonly runtimeHandles = new Set<string>();
  private readonly attachments = new Map<string, ProviderSessionOciAttachment>();
  private readonly attaching = new Set<string>();
  private readonly pendingLaunches = new Set<string>();
  private readonly pendingProcesses = new Set<string>();
  private readonly pendingSessions = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly pendingTeardowns = new Map<string, ProviderSessionPendingTeardown>();
  private readonly stopping = new Set<string>();
  private capabilityGeneration = 0;
  private capabilitySignature = '';
  private closed = false;
  private poisoned = false;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: ProviderSessionContainerSupervisorOptions) {
    const maxActive = options.maxActive ?? PROVIDER_SESSION_MAX_ACTIVE_CONTAINERS;
    if (!Number.isSafeInteger(maxActive) || maxActive < 1 ||
        maxActive > PROVIDER_SESSION_MAX_ACTIVE_CONTAINERS) {
      throw new Error('provider session active-container limit is invalid');
    }
    this.maxActive = maxActive;
    this.images = Object.freeze({
      'claude-code-v1': options.images['claude-code-v1'] ?? null,
      'codex-cli-v1': options.images['codex-cli-v1'] ?? null,
      'grok-build-v1': options.images['grok-build-v1'] ?? null,
    });
  }

  async capabilities(): Promise<ProviderSessionSupervisorCapabilities> {
    let available = false;
    let adapterIds = availableProviderSessionAdapters(this.images);
    if (!this.closed && !this.poisoned && adapterIds.length > 0) {
      try {
        const readiness = await this.options.oci.probe();
        available = readiness.available && readiness.boundary === expectedBoundary(this.options.engine);
      } catch {
        available = false;
      }
    }
    if (!available) adapterIds = [];
    const state = {
      adapterIds,
      available,
      disabledReason: available ? null : UNAVAILABLE_REASON,
    } as const;
    const signature = JSON.stringify(state);
    if (signature !== this.capabilitySignature) {
      this.capabilitySignature = signature;
      this.capabilityGeneration += 1;
    }
    return parseProviderSessionSupervisorCapabilities({
      schemaVersion: PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION,
      ...state,
      generation: this.capabilityGeneration,
    });
  }

  async launch(value: ProviderSessionLaunchSpec): Promise<ProviderSessionLaunchResult> {
    const spec = parseProviderSessionLaunchSpec(value);
    this.assertLaunchAdmission(spec);
    const finishOperation = this.beginOperation();
    this.reserve(spec);
    let mount: ProviderSessionHostMountBinding | null = null;
    let plan: ProviderSessionOciPlan | null = null;
    let createAttempted = false;
    let createdHandle: string | undefined;
    let committed = false;
    try {
      const capabilities = await this.capabilities();
      if (!capabilities.available || !capabilities.adapterIds.includes(spec.adapterId)) {
        throw error('unavailable', 'Provider session isolation is unavailable');
      }
      this.assertLaunchFence();
      mount = await this.options.mounts.capture(spec);
      this.assertLaunchFence();
      plan = buildProviderSessionOciPlan({
        coreProcessId: this.options.coreProcessId,
        engine: this.options.engine,
        executable: this.options.executable,
        images: this.images,
        instanceId: this.options.instanceId,
        mount,
        runtimeUser: this.options.runtimeUser,
        spec,
      });
      await this.options.mounts.revalidate(mount);
      this.assertLaunchFence();
      if (await this.options.oci.inspect(plan.commands.inspect)) {
        throw error('conflict', 'Provider container identity is already occupied');
      }
      this.assertLaunchFence();
      createAttempted = true;
      await this.options.oci.run(plan.commands.create);
      const created = await this.requireInspection(plan, false);
      createdHandle = created.runtimeHandle;
      this.assertLaunchFence();
      await this.options.mounts.revalidate(mount);
      this.assertLaunchFence();
      await this.options.oci.run(plan.commands.start);
      const running = await this.requireInspection(plan, true, created.runtimeHandle);
      this.assertLaunchFence();
      if (this.runtimeHandles.has(running.runtimeHandle)) {
        throw error('conflict', 'Provider runtime identity is already active');
      }
      const lease = Object.freeze({
        mount,
        plan,
        runtimeHandle: running.runtimeHandle,
        spec,
      });
      this.leasesByProcess.set(spec.processId, lease);
      this.leasesBySession.set(spec.sessionId, lease);
      this.runtimeHandles.add(running.runtimeHandle);
      committed = true;
      return parseProviderSessionLaunchResult({
        schemaVersion: PROVIDER_SESSION_CONTAINER_SCHEMA_VERSION,
        launchId: spec.launchId,
        processId: spec.processId,
        runtimeHandle: running.runtimeHandle,
        sessionId: spec.sessionId,
      });
    } catch (cause) {
      if (!committed && mount) {
        try {
          if (createAttempted && plan) {
            await this.teardown(plan, mount, createdHandle, createdHandle === undefined);
          }
          else await this.options.mounts.release(mount);
        } catch {
          this.poisoned = true;
          this.pendingTeardowns.set(mount.bindingId, Object.freeze({
            ...(createdHandle === undefined ? {} : { expectedHandle: createdHandle }),
            mount,
            plan,
            ...(createAttempted && createdHandle === undefined ? { unresolvedCreate: true } : {}),
          }));
          throw error('identity-changed', 'Provider launch cleanup could not prove container identity');
        }
      }
      throw this.project(cause, 'unavailable', 'Provider session launch failed');
    } finally {
      this.unreserve(spec);
      finishOperation();
    }
  }

  async stop(value: ProviderSessionStopSpec): Promise<ProviderSessionStopResult> {
    const spec = parseProviderSessionStopSpec(value);
    if (this.closed) throw error('closed', 'Provider session supervisor is closed');
    const lease = this.leasesByProcess.get(spec.processId);
    if (!lease || lease.spec.sessionId !== spec.sessionId ||
        lease.runtimeHandle !== spec.runtimeHandle) {
      throw error('not-found', 'Provider session lease is unavailable');
    }
    if (this.stopping.has(spec.processId) || this.attaching.has(spec.processId)) {
      throw error('conflict', 'Provider session teardown is already active');
    }
    const finishOperation = this.beginOperation();
    this.stopping.add(spec.processId);
    try {
      await this.retireAndTeardown(lease);
      this.forget(lease);
      return parseProviderSessionStopResult({ ...spec, stopped: true });
    } catch (cause) {
      this.poisoned = true;
      throw this.project(cause, 'teardown-failed', 'Provider session teardown failed');
    } finally {
      this.stopping.delete(spec.processId);
      finishOperation();
    }
  }

  async attach(value: ProviderSessionAttachSpec): Promise<ProviderSessionControlChannel> {
    const spec = parseProviderSessionAttachSpec(value);
    if (this.closed) throw error('closed', 'Provider session supervisor is closed');
    if (this.poisoned) throw error('unavailable', 'Provider session supervisor failed closed');
    const lease = this.leasesByProcess.get(spec.processId);
    if (!lease || lease.spec.sessionId !== spec.sessionId ||
        lease.runtimeHandle !== spec.runtimeHandle) {
      throw error('not-found', 'Provider session lease is unavailable');
    }
    if (this.stopping.has(spec.processId) || this.attaching.has(spec.processId) ||
        this.attachments.has(spec.processId)) {
      throw error('conflict', 'Provider session control channel is already active');
    }
    const finishOperation = this.beginOperation();
    this.attaching.add(spec.processId);
    let attachment: ProviderSessionOciAttachment | null = null;
    try {
      await this.options.mounts.revalidate(lease.mount);
      this.assertLaunchFence();
      await this.requireInspection(lease.plan, true, lease.runtimeHandle);
      attachment = await this.options.oci.attach(lease.plan.commands.attach);
      this.assertLaunchFence();
      await this.requireInspection(lease.plan, true, lease.runtimeHandle);
      await this.options.mounts.revalidate(lease.mount);
      this.assertLaunchFence();
      this.attachments.set(spec.processId, attachment);
      const adopted = attachment;
      const retire = (): void => {
        if (this.attachments.get(spec.processId) === adopted) {
          this.attachments.delete(spec.processId);
        }
      };
      void adopted.exited.then(retire, retire);
      return Object.freeze({
        exited: adopted.exited,
        stream: adopted.stream,
        close: async () => {
          if (this.attachments.get(spec.processId) === adopted) {
            this.attachments.delete(spec.processId);
          }
          await adopted.close();
        },
      });
    } catch (cause) {
      if (attachment) await attachment.close().catch(() => undefined);
      throw this.project(cause, 'unavailable', 'Provider session control attach failed');
    } finally {
      this.attaching.delete(spec.processId);
      finishOperation();
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeOnce().finally(() => { this.closePromise = null; });
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    if (this.closed && this.leasesByProcess.size === 0 && this.pendingTeardowns.size === 0 &&
        this.inFlight.size === 0) return;
    this.closed = true;
    await Promise.allSettled([...this.inFlight]);
    const failures: Error[] = [];
    await Promise.all([
      ...[...this.leasesByProcess.values()].map(async (lease) => {
        try {
          await this.retireAndTeardown(lease);
          this.forget(lease);
        } catch {
          this.poisoned = true;
          failures.push(error('teardown-failed', 'Provider session teardown failed'));
        }
      }),
      ...[...this.pendingTeardowns].map(async ([bindingId, pending]) => {
        try {
          if (pending.plan) await this.teardown(
            pending.plan, pending.mount, pending.expectedHandle,
            pending.unresolvedCreate === true,
          );
          else await this.options.mounts.release(pending.mount);
          this.pendingTeardowns.delete(bindingId);
        } catch {
          failures.push(error('teardown-failed', 'Provider pending teardown failed'));
        }
      }),
    ]);
    if (failures.length > 0) throw new AggregateError(failures, 'Provider supervisor close failed');
  }

  private assertLaunchAdmission(spec: ProviderSessionLaunchSpec): void {
    if (this.closed) throw error('closed', 'Provider session supervisor is closed');
    if (this.poisoned) throw error('unavailable', 'Provider session supervisor failed closed');
    if (this.leasesByProcess.size + this.pendingProcesses.size >= this.maxActive) {
      throw error('limit', 'Provider session container limit reached');
    }
    if (
      this.leasesByProcess.has(spec.processId) || this.pendingProcesses.has(spec.processId) ||
      this.leasesBySession.has(spec.sessionId) || this.pendingSessions.has(spec.sessionId) ||
      this.pendingLaunches.has(spec.launchId)
    ) throw error('conflict', 'Provider session launch identity is already active');
  }

  private reserve(spec: ProviderSessionLaunchSpec): void {
    this.pendingLaunches.add(spec.launchId);
    this.pendingProcesses.add(spec.processId);
    this.pendingSessions.add(spec.sessionId);
  }

  private beginOperation(): () => void {
    let finish!: () => void;
    const operation = new Promise<void>((resolve) => { finish = resolve; });
    this.inFlight.add(operation);
    return () => {
      this.inFlight.delete(operation);
      finish();
    };
  }

  private assertLaunchFence(): void {
    if (this.closed) throw error('closed', 'Provider session supervisor is closed');
    if (this.poisoned) throw error('unavailable', 'Provider session supervisor failed closed');
  }

  private unreserve(spec: ProviderSessionLaunchSpec): void {
    this.pendingLaunches.delete(spec.launchId);
    this.pendingProcesses.delete(spec.processId);
    this.pendingSessions.delete(spec.sessionId);
  }

  private async requireInspection(
    plan: ProviderSessionOciPlan,
    running: boolean,
    runtimeHandle?: string,
  ): Promise<ProviderSessionOciInspection> {
    const inspection = await this.options.oci.inspect(plan.commands.inspect);
    if (!inspection) throw error('identity-changed', 'Provider container identity disappeared');
    try {
      assertProviderSessionOciInspection(plan, inspection, { running, runtimeHandle });
    } catch {
      throw error('identity-changed', 'Provider container identity changed');
    }
    return inspection;
  }

  private async teardown(
    plan: ProviderSessionOciPlan,
    mount: ProviderSessionHostMountBinding,
    expectedHandle?: string,
    unresolvedCreate = false,
  ): Promise<void> {
    let current = await this.options.oci.inspect(plan.commands.inspect);
    if (!current && unresolvedCreate) current = await this.reconcileCreate(plan);
    if (!current) {
      if (unresolvedCreate) {
        throw error('teardown-failed', 'Provider container create authority remains unresolved');
      }
      await this.options.mounts.release(mount);
      return;
    }
    try {
      assertProviderSessionOciInspection(plan, current, {
        running: current.running,
        runtimeHandle: expectedHandle,
      });
    } catch {
      throw error('identity-changed', 'Provider container identity changed before teardown');
    }
    const runtimeHandle = expectedHandle ?? current.runtimeHandle;
    if (current.running) {
      await this.options.oci.run(plan.commands.stop);
      current = await this.requireInspection(plan, false, runtimeHandle);
    }
    await this.options.oci.run(plan.commands.remove);
    if (await this.options.oci.inspect(plan.commands.inspect)) {
      throw error('teardown-failed', 'Provider container removal was not durable');
    }
    await this.options.mounts.release(mount);
  }

  private async reconcileCreate(plan: ProviderSessionOciPlan):
  Promise<ProviderSessionOciInspection | null> {
    const delay = this.options.createReconcileDelay ?? defaultCreateReconcileDelay;
    for (let attempt = 0; attempt < CREATE_RECONCILE_ATTEMPTS; attempt += 1) {
      await delay();
      const inspection = await this.options.oci.inspect(plan.commands.inspect);
      if (inspection) return inspection;
    }
    return null;
  }

  private forget(lease: ProviderSessionLease): void {
    this.leasesByProcess.delete(lease.spec.processId);
    this.leasesBySession.delete(lease.spec.sessionId);
    this.runtimeHandles.delete(lease.runtimeHandle);
    this.attachments.delete(lease.spec.processId);
  }

  private async retireAttachment(processId: string): Promise<void> {
    const attachment = this.attachments.get(processId);
    if (!attachment) return;
    this.attachments.delete(processId);
    await attachment.close();
  }

  private async retireAndTeardown(lease: ProviderSessionLease): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.retireAttachment(lease.spec.processId);
    } catch (cause) {
      failures.push(cause);
    }
    try {
      await this.teardown(lease.plan, lease.mount, lease.runtimeHandle);
    } catch (cause) {
      failures.push(cause);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Provider session control retirement failed');
    }
  }

  private project(
    cause: unknown,
    fallbackCode: ConstructorParameters<typeof ProviderSessionSupervisorError>[0],
    message: string,
  ): ProviderSessionSupervisorError {
    return cause instanceof ProviderSessionSupervisorError
      ? cause
      : error(fallbackCode, message);
  }
}
