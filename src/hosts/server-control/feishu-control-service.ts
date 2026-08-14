import { randomBytes } from 'node:crypto';
import { lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { isJsonObject, type JsonValue } from '@contracts/index';
import { parseFeishuProductionConfig } from '@gateways/feishu/config';
import { parseFeishuCoreSshConfig } from '@hosts/feishu/config';
import {
  commitManagedTextTransaction,
  readTrustedTextFile,
} from '@hosts/linux-runtime/connection-credential-issuer';
import {
  appendManagedLine,
  loadConnectionAuthority,
  renderForcedClientKey,
  verifyManagedAuthorizedKeys,
  type LoadedConnectionAuthority,
} from './connection-authority';
import type { ServerControlConfig } from './config';
import {
  commitServerConnectionTransaction,
  prepareServerConnectionRecord,
  ServerConnectionService,
} from './connection-service';
import {
  FeishuManagementClient,
  type FeishuManagementClientPort,
} from './feishu-management-client';
import {
  FEISHU_PROTECTED_FILES,
  PRODUCTION_FEISHU_PATHS,
  renderFeishuProvisioning,
  type FeishuProvisioningPaths,
} from './feishu-provisioning';
import type {
  FeishuConnectRequest, FeishuDisconnectRequest, FeishuRotateCredentialRequest,
} from './feishu-request';
import { applyFeishuCredentialRotation, settleFeishuCredentialTransition } from './feishu-rotation';
import { activateDesiredFeishuRuntime, inspectFeishuRuntimeRelease } from './feishu-runtime-release';
import {
  FEISHU_RUNTIME_VERIFIER,
  type FeishuRuntimeVerifierPort,
} from './feishu-runtime-verifier';
import {
  FEISHU_LIVE_ACCEPTANCE,
  feishuRuntimeSummary,
  parseFeishuManagementStatus,
  redactFeishuManagementStatus,
  redactFeishuPairingResult,
  requireHealthyFeishuManagement,
} from './feishu-status';
import { SYSTEMD_CONTROL, type SystemdControlPort } from './systemd';
const CONTROL = /[\u0000-\u0020\u007f-\u009f]/u;
export interface FeishuControlServiceOptions {
  readonly paths?: FeishuProvisioningPaths;
  readonly systemd?: SystemdControlPort;
  readonly now?: () => number;
  readonly managementClient?: FeishuManagementClientPort;
  readonly runtimeVerifier?: FeishuRuntimeVerifierPort;
}
function actionSecret(): string {
  const bytes = randomBytes(32);
  try {
    return bytes.toString('base64url');
  } finally {
    bytes.fill(0);
  }
}

function appSecret(path: string): string {
  const file = readTrustedTextFile(path);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : file.uid;
  if (file.mode !== 0o600 || file.uid !== currentUid) {
    throw new Error('Feishu app secret source is not root-private');
  }
  const value = file.text.replace(/\r?\n$/u, '');
  if (
    Buffer.byteLength(value, 'utf8') < 32 || Buffer.byteLength(value, 'utf8') > 1_024 ||
    CONTROL.test(value)
  ) throw new Error('Feishu app secret source has an invalid format');
  return value;
}

function virtualAuthority(
  loaded: LoadedConnectionAuthority,
  records: LoadedConnectionAuthority['records'],
  authorizedKeys: string,
): LoadedConnectionAuthority {
  return {
    ...loaded,
    records,
    authorizedKeysFile: { ...loaded.authorizedKeysFile, text: authorizedKeys },
  };
}

function requireDirectory(
  path: string,
  owner: { uid: number; gid: number },
  mode: number,
): void {
  const metadata = lstatSync(path);
  if (
    !metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(path) !== path ||
    metadata.uid !== owner.uid || metadata.gid !== owner.gid || (metadata.mode & 0o777) !== mode
  ) throw new Error('Feishu provisioning directory trust check failed');
}

function protectedFilePaths(paths: FeishuProvisioningPaths): string[] {
  return FEISHU_PROTECTED_FILES.map((field) => paths[field]);
}

export class FeishuControlService {
  private readonly paths: FeishuProvisioningPaths;
  private readonly systemd: SystemdControlPort;
  private readonly now: () => number;
  private readonly management: FeishuManagementClientPort;
  private readonly runtimeVerifier: FeishuRuntimeVerifierPort;

  constructor(
    private readonly config: ServerControlConfig,
    options: FeishuControlServiceOptions = {},
  ) {
    this.paths = options.paths ?? PRODUCTION_FEISHU_PATHS;
    this.systemd = options.systemd ?? SYSTEMD_CONTROL;
    this.now = options.now ?? Date.now;
    this.management = options.managementClient ?? new FeishuManagementClient(
      this.paths.managementSocket,
      config.feishuIdentityOwner.uid,
    );
    this.runtimeVerifier = options.runtimeVerifier ?? FEISHU_RUNTIME_VERIFIER;
  }

  async connect(request: FeishuConnectRequest): Promise<JsonValue> {
    this.verifyDirectories();
    const runtime = feishuRuntimeSummary(inspectFeishuRuntimeRelease(this.paths));
    this.runtimeVerifier.verifyActive();
    const loaded = loadConnectionAuthority(this.config);
    const existing = loaded.records.find((entry) => entry.credentialId === request.credentialId);
    if (existing) {
      if (existing.surface !== 'feishu' || existing.status !== 'active') {
        throw new Error('Feishu credential id is already registered');
      }
      this.verifyFiles(request);
      this.systemd.daemonReload();
      this.systemd.enableNow(this.paths.serviceUnit);
      const management = await this.requireHealthyManagement();
      return {
        status: 'already-connected',
        credentialId: request.credentialId,
        service: 'active',
        runtime,
        management,
      };
    }
    if (
      loaded.allCredentialIds.has(request.credentialId) ||
      loaded.records.some((entry) => entry.surface === 'feishu' && entry.status === 'active')
    ) throw new Error('An active Feishu connection already exists');
    const prepared = prepareServerConnectionRecord({
      config: this.config,
      credentialId: request.credentialId,
      surface: 'feishu',
      label: request.label,
      outputFile: this.paths.identity,
      now: this.now(),
    });
    if (prepared.issue.credential.purpose !== 'client') {
      throw new Error('Feishu provisioning received a non-client credential');
    }
    const secret = appSecret(request.appSecretFile);
    const rendered = renderFeishuProvisioning({
      config: this.config,
      request,
      credential: prepared.issue.credential,
      appSecret: secret,
      actionSecret: actionSecret(),
      paths: this.paths,
    });
    const records = Object.freeze([...loaded.records, prepared.record]);
    const authorizedKeys = appendManagedLine(
      loaded.authorizedKeysFile.text,
      renderForcedClientKey(this.config, prepared.record),
    );
    verifyManagedAuthorizedKeys(virtualAuthority(loaded, records, authorizedKeys), this.config);
    let committed = false;
    try {
      commitServerConnectionTransaction(
        loaded,
        loaded.encode(records),
        authorizedKeys,
        rendered.outputs,
      );
      committed = true;
      new ServerConnectionService(this.config).verify();
      this.systemd.daemonReload();
      this.systemd.enableNow(this.paths.serviceUnit);
      const management = await this.requireHealthyManagement();
      return {
        status: 'connected',
        credentialId: request.credentialId,
        service: 'active',
        runtime,
        management,
      };
    } catch (error) {
      try { this.systemd.stopDisable(this.paths.serviceUnit); } catch {}
      if (committed) this.rollbackProvisioning(loaded);
      throw error;
    }
  }

  async status(): Promise<JsonValue> {
    let runtime: JsonValue;
    try {
      runtime = feishuRuntimeSummary(inspectFeishuRuntimeRelease(this.paths));
    } catch {
      runtime = { state: 'unavailable' };
    }
    const active = this.systemd.isActive(this.paths.serviceUnit);
    if (!active) {
      return {
        service: 'inactive', runtime, managementReachable: false, management: null,
        liveAcceptance: FEISHU_LIVE_ACCEPTANCE,
      };
    }
    try {
      return {
        service: 'active',
        runtime,
        managementReachable: true,
        management: redactFeishuManagementStatus(parseFeishuManagementStatus(
          await this.management.request('status', {}), this.config,
        )),
        liveAcceptance: FEISHU_LIVE_ACCEPTANCE,
      };
    } catch {
      return {
        service: 'active', runtime, managementReachable: false, management: null,
        liveAcceptance: FEISHU_LIVE_ACCEPTANCE,
      };
    }
  }

  check(): JsonValue {
    this.verifyDirectories();
    new ServerConnectionService(this.config).verify();
    const runtime = feishuRuntimeSummary(inspectFeishuRuntimeRelease(this.paths));
    this.runtimeVerifier.verifyActive();
    return {
      status: 'ready',
      instanceId: this.config.instanceId,
      topology: this.config.topology,
      runtime,
    };
  }

  dryRun(request: FeishuConnectRequest): JsonValue {
    const checked = this.check();
    const loaded = loadConnectionAuthority(this.config);
    const existing = loaded.records.find((entry) => entry.credentialId === request.credentialId);
    if (existing) {
      if (existing.surface !== 'feishu' || existing.status !== 'active') {
        throw new Error('Feishu credential id is already registered');
      }
      this.verifyFiles(request);
      return { status: 'already-connected', check: checked };
    }
    if (
      loaded.allCredentialIds.has(request.credentialId) ||
      loaded.records.some((entry) => entry.surface === 'feishu' && entry.status === 'active')
    ) throw new Error('An active Feishu connection already exists');
    void appSecret(request.appSecretFile);
    return {
      status: 'ready-to-connect',
      credentialId: request.credentialId,
      check: checked,
    };
  }

  async verify(): Promise<JsonValue> {
    new ServerConnectionService(this.config).verify();
    this.verifyFiles();
    const runtime = feishuRuntimeSummary(inspectFeishuRuntimeRelease(this.paths));
    return {
      service: 'active',
      runtime,
      management: await this.requireHealthyManagement(),
      liveAcceptance: FEISHU_LIVE_ACCEPTANCE,
    };
  }

  async upgrade(): Promise<JsonValue> {
    this.verifyFiles();
    const runtime = activateDesiredFeishuRuntime(inspectFeishuRuntimeRelease(this.paths));
    this.systemd.daemonReload();
    try {
      this.systemd.restart(this.paths.serviceUnit);
      return {
        status: runtime.changed ? 'upgraded' : 'restarted-current',
        runtime: {
          activeDigest: runtime.activeDigest,
          previousDigest: runtime.previousDigest,
        },
        management: await this.requireHealthyManagement(),
      };
    } catch (error) {
      if (!runtime.changed) throw error;
      try {
        runtime.rollback();
        this.systemd.restart(this.paths.serviceUnit);
        await this.requireHealthyManagement();
      } catch (rollbackError) {
        throw new Error('Feishu runtime rollback was incomplete', { cause: rollbackError });
      }
      throw error;
    }
  }

  async rotateCredential(request: FeishuRotateCredentialRequest): Promise<JsonValue> {
    this.verifyFiles(undefined, undefined);
    const healthBefore = await this.requireHealthyManagementState();
    const pairing = healthBefore.rawStatus.pairing;
    if (!isJsonObject(pairing)) throw new Error('Feishu pairing status is invalid');
    const pairedOpenId = typeof pairing.openId === 'string' ? pairing.openId : null;
    const loaded = loadConnectionAuthority(this.config);
    const current = loaded.records.find((entry) => entry.credentialId === request.credentialId);
    const next = loaded.records.find((entry) => entry.credentialId === request.nextCredentialId);
    if (
      current?.surface === 'feishu' && current.status === 'revoked' &&
      next?.surface === 'feishu' && next.status === 'active'
    ) {
      this.systemd.restart(this.paths.serviceUnit);
      const management = await this.requireHealthyManagement();
      new ServerConnectionService(this.config).verify();
      this.verifyFiles(undefined, request.nextCredentialId);
      settleFeishuCredentialTransition(this.paths, request.nextCredentialId);
      return {
        status: 'already-rotated',
        credentialId: request.nextCredentialId,
        replacedCredentialId: request.credentialId,
        management,
      };
    }
    const applied = applyFeishuCredentialRotation({
      config: this.config,
      paths: this.paths,
      request,
      pairedOpenId,
      now: this.now(),
    });
    let management: JsonValue;
    try {
      this.systemd.restart(this.paths.serviceUnit);
      management = await this.requireHealthyManagement();
      new ServerConnectionService(this.config).verify();
      this.verifyFiles(undefined, request.nextCredentialId);
    } catch (error) {
      try {
        applied.rollback();
        this.systemd.restart(this.paths.serviceUnit);
        await this.requireHealthyManagement();
        settleFeishuCredentialTransition(this.paths, request.credentialId);
      } catch (rollbackError) {
        throw new Error('Feishu credential rotation rollback was incomplete', {
          cause: rollbackError,
        });
      }
      throw error;
    }
    settleFeishuCredentialTransition(this.paths, request.nextCredentialId);
    return {
      status: 'rotated',
      credentialId: applied.credentialId,
      replacedCredentialId: applied.replacedCredentialId,
      management,
    };
  }

  async disconnect(request: FeishuDisconnectRequest): Promise<JsonValue> {
    this.systemd.stopDisable(this.paths.serviceUnit);
    const revoked = new ServerConnectionService(this.config, this.now).revoke({
      schemaVersion: 1,
      credentialId: request.credentialId,
      surface: 'feishu',
    });
    this.removeProtectedFiles();
    new ServerConnectionService(this.config).verify();
    return {
      status: revoked.status === 'already-revoked' ? 'already-disconnected' : 'disconnected',
      credentialId: request.credentialId,
      statePreserved: true,
    };
  }

  pairCreate(): Promise<JsonValue> {
    return this.management.request('pair.code.create', {});
  }

  pairList(all = false): Promise<JsonValue> {
    return this.management.request('pair.list', { status: all ? 'all' : 'pending' })
      .then(redactFeishuPairingResult);
  }

  pairApprove(requestId: string): Promise<JsonValue> {
    return this.management.request('pair.approve', { requestId })
      .then(redactFeishuPairingResult);
  }

  pairReject(requestId: string): Promise<JsonValue> {
    return this.management.request('pair.reject', { requestId })
      .then(redactFeishuPairingResult);
  }

  private verifyDirectories(): void {
    const root = typeof process.getuid === 'function' ? process.getuid() : 0;
    requireDirectory(this.paths.configDirectory, {
      uid: root,
      gid: this.config.feishuIdentityOwner.gid,
    }, 0o750);
    requireDirectory(this.paths.stateDirectory, this.config.feishuIdentityOwner, 0o700);
  }

  private verifyFiles(expected?: FeishuConnectRequest, expectedCredentialId?: string): void {
    for (const path of protectedFilePaths(this.paths)) {
      const file = readTrustedTextFile(path);
      if (
        file.mode !== 0o600 || file.uid !== this.config.feishuIdentityOwner.uid ||
        file.gid !== this.config.feishuIdentityOwner.gid
      ) throw new Error('Feishu protected file trust check failed');
    }
    const gateway = parseFeishuProductionConfig(JSON.parse(
      readTrustedTextFile(this.paths.gatewayConfig).text,
    ));
    const core = parseFeishuCoreSshConfig(JSON.parse(
      readTrustedTextFile(this.paths.coreSshConfig).text,
    ));
    if (
      gateway.instanceId !== this.config.instanceId || gateway.topology !== this.config.topology ||
      core.instanceId !== this.config.instanceId || core.topology !== this.config.topology ||
      core.appVersion !== this.config.appVersion || gateway.credentials.length !== 1 ||
      core.credentials.length !== 1 ||
      gateway.credentials[0]?.credentialId !== core.credentials[0]?.credentialId ||
      (expectedCredentialId !== undefined &&
        gateway.credentials[0]?.credentialId !== expectedCredentialId) ||
      (expected && (gateway.appId !== expected.appId || gateway.tenantKey !== expected.tenantKey ||
        gateway.credentials[0]?.credentialId !== expected.credentialId))
    ) throw new Error('Feishu protected configuration binding is invalid');
  }

  private async requireHealthyManagement(): Promise<JsonValue> {
    return (await this.requireHealthyManagementState()).publicStatus;
  }

  private async requireHealthyManagementState(): Promise<{
    readonly rawStatus: ReturnType<typeof parseFeishuManagementStatus>;
    readonly publicStatus: JsonValue;
  }> {
    return requireHealthyFeishuManagement({
      config: this.config,
      management: this.management,
      systemd: this.systemd,
      serviceUnit: this.paths.serviceUnit,
    });
  }

  private rollbackProvisioning(original: LoadedConnectionAuthority): void {
    let failure: unknown = null;
    try { this.removeProtectedFiles(); } catch (error) { failure = error; }
    try {
      const current = loadConnectionAuthority(this.config);
      commitManagedTextTransaction({
        mutations: [
          { current: current.authorityFile, next: original.authorityFile.text },
          { current: current.authorizedKeysFile, next: original.authorizedKeysFile.text },
        ],
      });
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw new Error('Feishu connect rollback was incomplete', { cause: failure });
  }

  private removeProtectedFiles(): void {
    let failure: unknown = null;
    for (const path of [...protectedFilePaths(this.paths)].reverse()) {
      try {
        const metadata = lstatSync(path, { throwIfNoEntry: false });
        if (!metadata) continue;
        if (
          !metadata.isFile() || metadata.isSymbolicLink() ||
          metadata.uid !== this.config.feishuIdentityOwner.uid ||
          metadata.gid !== this.config.feishuIdentityOwner.gid || (metadata.mode & 0o777) !== 0o600
        ) throw new Error('untrusted protected file');
        unlinkSync(path);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw new Error('Feishu protected files could not be removed', { cause: failure });
  }
}
