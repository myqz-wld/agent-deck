import { validateManagerRoots } from './artifacts';
import type { InstanceManagerContext } from './context';
import { createInstance } from './create';
import { resolveInstancePaths, validateConfiguredRoots } from './paths';
import { loadInstance } from './instance-reader';
import { listInstances } from './list';
import { InstanceOperationLocks } from './locks';
import { startInstance, statusInstance, stopInstance } from './lifecycle';
import {
  planCreate,
  planExisting,
  planList,
  planRollback,
  planUpgrade,
} from './plans';
import { planRemove, removeInstance } from './remove';
import { rollbackInstance, upgradeInstance } from './change';
import { assertNoPendingOperation, recoverPendingOperation } from './recovery';
import type {
  CreateInstanceRequest,
  InstanceManagerPorts,
  InstanceManagerRoots,
  InstanceDeploymentState,
  InstanceOperationPlan,
  InstanceSelector,
  InstanceStatus,
  InstanceSummary,
  ManagerLimits,
  RemoveInstanceRequest,
  RemovePlan,
  RemovePlanRequest,
  UpgradeInstanceRequest,
  VersionFence,
} from './types';
import { fail, InstanceManagerError, isInside, requirePositiveSafeInteger, validateOperationId } from './validation';

export interface InstanceManagerOptions {
  readonly ports: InstanceManagerPorts;
  readonly roots: InstanceManagerRoots;
  readonly limits: ManagerLimits;
  readonly serviceUid: number;
  readonly trustedRootUid: number;
  readonly trustedArtifactUid: number;
}

function key(selector: InstanceSelector): string {
  return `${selector.topology}:${selector.instanceId}`;
}

function assertSeparatedRoots(roots: InstanceManagerRoots): void {
  validateConfiguredRoots(roots);
  const protectedRoots = [
    roots.unitRoot,
    roots.metadataRoot,
    roots.backupRoot,
    roots.journalRoot,
    roots.runtimeRoot,
    roots.relayEvidenceRoot,
    roots.cutoverEvidenceRoot,
  ];
  for (const [index, left] of protectedRoots.entries()) {
    for (const right of protectedRoots.slice(index + 1)) {
      if (isInside(left, right) || isInside(right, left)) {
        fail('invalid_input', 'manager mutable and evidence roots must be disjoint');
      }
    }
  }
  for (const managerRoot of [roots.metadataRoot, roots.backupRoot, roots.journalRoot, roots.runtimeRoot, roots.relayEvidenceRoot, roots.cutoverEvidenceRoot]) {
    if (isInside(managerRoot, roots.serviceHome) || isInside(roots.serviceHome, managerRoot)) {
      fail('invalid_input', 'only the exact rootless user-unit root may live under serviceHome');
    }
  }
  if (roots.fullTemplatePath === roots.relayTemplatePath || roots.fullPreflightPath === roots.relayPreflightPath) {
    fail('invalid_input', 'Full and Relay template/preflight inputs must be distinct');
  }
  const inputs = [roots.fullTemplatePath, roots.fullPreflightPath, roots.relayTemplatePath, roots.relayPreflightPath];
  if (new Set(inputs).size !== inputs.length) fail('invalid_input', 'all trusted template and preflight inputs must be distinct');
  for (const input of inputs) {
    for (const protectedRoot of [roots.serviceHome, ...protectedRoots]) {
      if (isInside(input, protectedRoot) || isInside(protectedRoot, input)) {
        fail('invalid_input', 'trusted template/preflight inputs must be outside manager namespaces');
      }
    }
  }
  const full = resolveInstancePaths(roots, 'full', 'namespace-check');
  const relay = resolveInstancePaths(roots, 'relay', 'namespace-check');
  for (const runtimeNamespace of [full.configDirectory, full.runtimeDirectory, relay.configDirectory, relay.stateDirectory as string, relay.runtimeDirectory]) {
    if (isInside(runtimeNamespace, roots.unitRoot) || isInside(roots.unitRoot, runtimeNamespace)) {
      fail('invalid_input', 'rootless unit root overlaps an agent-visible instance namespace');
    }
  }
  const derived = [
    full.configDirectory, full.runtimeDirectory, full.metadataDirectory, full.backupDirectory,
    full.cutoverEvidenceDirectory, full.journalPath, full.unitPath,
    relay.configDirectory, relay.stateDirectory as string, relay.runtimeDirectory,
    relay.metadataDirectory, relay.backupDirectory, relay.evidenceDirectory,
    relay.cutoverEvidenceDirectory, relay.journalPath, relay.unitPath,
  ];
  for (const [index, left] of derived.entries()) {
    for (const right of derived.slice(index + 1)) {
      if (isInside(left, right) || isInside(right, left)) {
        fail('invalid_input', 'derived per-instance namespaces unexpectedly overlap');
      }
    }
  }
}

function validateOptions(options: InstanceManagerOptions): InstanceManagerContext {
  requirePositiveSafeInteger(options.serviceUid, 'serviceUid');
  requirePositiveSafeInteger(options.trustedRootUid + 1, 'trustedRootUid');
  requirePositiveSafeInteger(options.trustedArtifactUid + 1, 'trustedArtifactUid');
  for (const [field, value] of Object.entries(options.limits)) {
    requirePositiveSafeInteger(value, `limits.${field}`);
  }
  assertSeparatedRoots(options.roots);
  return options;
}

export class LinuxInstanceManager {
  private readonly context: InstanceManagerContext;
  private readonly locks = new InstanceOperationLocks();
  private readonly ownerToken: string;

  constructor(options: InstanceManagerOptions) {
    this.context = validateOptions(options);
    this.ownerToken = options.ports.ids.nextId();
    validateOperationId(this.ownerToken);
  }

  private async ready(): Promise<void> {
    await validateManagerRoots(this.context);
  }

  private runLocked<T>(selector: InstanceSelector, operation: () => Promise<T>, recover = false): Promise<T> {
    return this.runLockedKey(key(selector), async () => {
      if (recover) await recoverPendingOperation(this.context, selector);
      else await assertNoPendingOperation(this.context, selector);
      return operation();
    });
  }

  private runLockedKey<T>(lockKey: string, operation: () => Promise<T>): Promise<T> {
    return this.locks.run(lockKey, async () => {
      let lease;
      try {
        lease = await this.context.ports.leases.acquire({
          key: lockKey,
          ownerToken: this.ownerToken,
          timeoutMs: this.context.limits.commandTimeoutMs,
        });
      } catch (error) {
        throw new InstanceManagerError('lock_failed', 'exact instance host lease could not be acquired', { cause: error });
      }
      if (!lease || typeof lease !== 'object' ||
        lease.key !== lockKey || lease.ownerToken !== this.ownerToken ||
        typeof lease.lockId !== 'string' || !lease.lockId ||
        !Number.isSafeInteger(lease.acquiredAtMs) || lease.acquiredAtMs < 0) {
        try {
          await this.context.ports.leases.quarantine(lease, this.context.limits.commandTimeoutMs);
        } catch (cleanup) {
          throw new InstanceManagerError('cleanup_failed', 'invalid host lock handle could not be quarantined', { cause: cleanup });
        }
        throw new InstanceManagerError('lock_failed', 'host lock returned an invalid ownership fence');
      }
      let result: T | undefined;
      let primary: unknown;
      try {
        result = await operation();
      } catch (error) {
        primary = error;
      }
      try {
        await this.context.ports.leases.release(lease, this.context.limits.commandTimeoutMs);
      } catch (releaseError) {
        throw new InstanceManagerError('cleanup_failed', 'host lock release failed; ownership state is unrecovered', {
          cause: new AggregateError(primary === undefined ? [releaseError] : [primary, releaseError]),
        });
      }
      if (primary !== undefined) throw primary;
      return result as T;
    });
  }

  async planList(): Promise<InstanceOperationPlan> {
    await this.ready();
    return planList();
  }

  async planCreate(request: CreateInstanceRequest): Promise<InstanceOperationPlan> {
    await this.ready();
    return this.runLocked(request, () => planCreate(this.context, request));
  }

  async planStart(selector: InstanceSelector): Promise<InstanceOperationPlan> {
    await this.ready();
    return this.runLocked(selector, () => planExisting(this.context, 'start', selector));
  }

  async planStop(selector: InstanceSelector): Promise<InstanceOperationPlan> {
    await this.ready();
    return this.runLocked(selector, () => planExisting(this.context, 'stop', selector));
  }

  async planStatus(selector: InstanceSelector): Promise<InstanceOperationPlan> {
    await this.ready();
    return this.runLocked(selector, () => planExisting(this.context, 'status', selector));
  }

  async planUpgrade(request: UpgradeInstanceRequest): Promise<InstanceOperationPlan> {
    await this.ready();
    return this.runLocked(request, () => planUpgrade(this.context, request));
  }

  async planRollback(request: VersionFence): Promise<InstanceOperationPlan> {
    await this.ready();
    return this.runLocked(request, () => planRollback(this.context, request));
  }

  async planRemove(request: RemovePlanRequest): Promise<RemovePlan> {
    await this.ready();
    return this.runLocked(request, () => planRemove(this.context, request));
  }

  async create(request: CreateInstanceRequest): Promise<InstanceSummary> {
    await this.ready();
    return this.runLocked(request, () => createInstance(this.context, request), true);
  }

  async list(): Promise<readonly InstanceSummary[]> {
    await this.ready();
    return listInstances(this.context, (lockKey, operation) => {
      const [topology, instanceId] = lockKey.split(':') as ['full' | 'relay', string];
      return this.runLocked({ topology, instanceId }, operation);
    });
  }

  async start(selector: InstanceSelector): Promise<InstanceStatus> {
    await this.ready();
    return this.runLocked(selector, () => startInstance(this.context, selector), true);
  }

  async stop(selector: InstanceSelector): Promise<InstanceStatus> {
    await this.ready();
    return this.runLocked(selector, () => stopInstance(this.context, selector), true);
  }

  async status(selector: InstanceSelector): Promise<InstanceStatus> {
    await this.ready();
    return this.runLocked(selector, () => statusInstance(this.context, selector));
  }

  async describe(selector: InstanceSelector): Promise<InstanceDeploymentState> {
    await this.ready();
    return this.runLocked(selector, async () => {
      const loaded = await loadInstance({
        selector,
        roots: this.context.roots,
        ports: this.context.ports,
        maxArtifactBytes: this.context.limits.maxArtifactBytes,
        serviceUid: this.context.serviceUid,
      });
      return {
        topology: loaded.record.topology,
        instanceId: loaded.record.instanceId,
        generation: loaded.record.generation,
        currentVersion: loaded.record.currentVersion,
        previousVersion: loaded.record.previousVersion,
        image: loaded.current.image,
        unitName: loaded.paths.unitName,
        unitPath: loaded.paths.unitPath,
        versions: loaded.record.versions.map((version) => ({
          version: version.version,
          image: version.image,
          unitSha256: version.unitSha256,
          fullResources: version.fullResources,
        })),
      };
    });
  }

  async upgrade(request: UpgradeInstanceRequest): Promise<InstanceStatus> {
    await this.ready();
    return this.runLocked(request, () => upgradeInstance(this.context, request), true);
  }

  async rollback(request: VersionFence): Promise<InstanceStatus> {
    await this.ready();
    return this.runLocked(request, () => rollbackInstance(this.context, request), true);
  }

  async remove(request: RemoveInstanceRequest): Promise<void> {
    await this.ready();
    return this.runLocked(request, () => removeInstance(this.context, request), true);
  }
}
