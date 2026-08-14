import { parseFeishuProductionConfig } from '@gateways/feishu/config';
import { parseFeishuCoreSshConfig } from '@hosts/feishu/config';
import {
  commitManagedTextTransaction,
  readTrustedTextFile,
  type CredentialIssueMutation,
  type TrustedTextFile,
} from '@hosts/linux-runtime/connection-credential-issuer';
import {
  appendManagedLine,
  loadConnectionAuthority,
  removeManagedCredentialLines,
  renderForcedClientKey,
  verifyManagedAuthorizedKeys,
} from './connection-authority';
import type { ServerControlConfig } from './config';
import {
  commitServerConnectionTransaction,
  prepareServerConnectionRecord,
} from './connection-service';
import type { FeishuProvisioningPaths } from './feishu-provisioning';
import type { FeishuRotateCredentialRequest } from './feishu-request';

function encoded(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function mutations(
  gatewayFile: TrustedTextFile,
  gatewayText: string,
  coreFile: TrustedTextFile,
  coreText: string,
  identityFile: TrustedTextFile,
  identityText: string,
): readonly CredentialIssueMutation[] {
  return [
    { current: gatewayFile, next: gatewayText },
    { current: coreFile, next: coreText },
    { current: identityFile, next: identityText },
  ];
}

export interface AppliedFeishuCredentialRotation {
  readonly credentialId: string;
  readonly replacedCredentialId: string;
  rollback(): void;
}

export function settleFeishuCredentialTransition(
  paths: FeishuProvisioningPaths,
  expectedCredentialId: string,
): void {
  const current = readTrustedTextFile(paths.gatewayConfig);
  const gateway = parseFeishuProductionConfig(JSON.parse(current.text));
  const credential = gateway.credentials[0];
  if (gateway.credentials.length !== 1 || credential?.credentialId !== expectedCredentialId) {
    throw new Error('Feishu credential transition binding is inconsistent');
  }
  if (credential.replacesCredentialId === null) return;
  const settled = parseFeishuProductionConfig({
    ...gateway,
    credentials: [{ ...credential, replacesCredentialId: null }],
  });
  commitManagedTextTransaction({
    mutations: [{ current, next: encoded(settled) }],
  });
}

export function applyFeishuCredentialRotation(input: {
  config: ServerControlConfig;
  paths: FeishuProvisioningPaths;
  request: FeishuRotateCredentialRequest;
  pairedOpenId: string | null;
  now: number;
}): AppliedFeishuCredentialRotation {
  const loaded = loadConnectionAuthority(input.config);
  const current = loaded.records.find(
    (entry) => entry.credentialId === input.request.credentialId,
  );
  if (!current || current.surface !== 'feishu' || current.status !== 'active') {
    throw new Error('Active Feishu rotation source was not found');
  }
  if (loaded.allCredentialIds.has(input.request.nextCredentialId)) {
    throw new Error('Next Feishu credential id is already registered');
  }
  const prepared = prepareServerConnectionRecord({
    config: input.config,
    credentialId: input.request.nextCredentialId,
    surface: 'feishu',
    label: input.request.label,
    outputFile: `${input.paths.identity}.next`,
    now: input.now,
  });
  if (prepared.issue.credential.purpose !== 'client') {
    throw new Error('Feishu rotation received a non-client credential');
  }
  const gatewayFile = readTrustedTextFile(input.paths.gatewayConfig);
  const coreFile = readTrustedTextFile(input.paths.coreSshConfig);
  const identityFile = readTrustedTextFile(input.paths.identity);
  const gateway = parseFeishuProductionConfig(JSON.parse(gatewayFile.text));
  const core = parseFeishuCoreSshConfig(JSON.parse(coreFile.text));
  if (
    gateway.credentials.length !== 1 || core.credentials.length !== 1 ||
    gateway.credentials[0]?.credentialId !== current.credentialId ||
    core.credentials[0]?.credentialId !== current.credentialId
  ) throw new Error('Feishu rotation source files are inconsistent');
  const nextGateway = parseFeishuProductionConfig({
    ...gateway,
    credentials: [{
      openId: input.pairedOpenId,
      credentialId: prepared.issue.credential.credentialId,
      connectionScope: prepared.issue.credential.connectionScope,
      replacesCredentialId: current.credentialId,
      status: 'active',
    }],
  });
  const nextCore = parseFeishuCoreSshConfig({
    ...core,
    credentials: [{
      credentialId: prepared.issue.credential.credentialId,
      connectionScope: prepared.issue.credential.connectionScope,
      identityFile: input.paths.identity,
    }],
  });
  const records = Object.freeze([
    ...loaded.records.map((entry) => entry.credentialId === current.credentialId
      ? Object.freeze({ ...entry, status: 'revoked' as const, revokedAt: input.now })
      : entry),
    prepared.record,
  ]);
  const authorizedKeys = appendManagedLine(
    removeManagedCredentialLines(
      loaded.authorizedKeysFile.text,
      input.config,
      current.credentialId,
    ),
    renderForcedClientKey(input.config, prepared.record),
  );
  verifyManagedAuthorizedKeys({
    ...loaded,
    records,
    authorizedKeysFile: { ...loaded.authorizedKeysFile, text: authorizedKeys },
  }, input.config);
  const nextGatewayText = encoded(nextGateway);
  const nextCoreText = encoded(nextCore);
  commitServerConnectionTransaction(
    loaded,
    loaded.encode(records),
    authorizedKeys,
    [],
    mutations(
      gatewayFile,
      nextGatewayText,
      coreFile,
      nextCoreText,
      identityFile,
      prepared.issue.credential.identity.privateKey,
    ),
  );
  const rollbackGateway = encoded(parseFeishuProductionConfig({
    ...gateway,
    credentials: [{
      ...gateway.credentials[0],
      openId: input.pairedOpenId,
      replacesCredentialId: prepared.issue.credential.credentialId,
    }],
  }));
  return Object.freeze({
    credentialId: prepared.record.credentialId,
    replacedCredentialId: current.credentialId,
    rollback: () => {
      const currentAuthority = loadConnectionAuthority(input.config);
      const currentGateway = readTrustedTextFile(input.paths.gatewayConfig);
      const currentCore = readTrustedTextFile(input.paths.coreSshConfig);
      const currentIdentity = readTrustedTextFile(input.paths.identity);
      commitManagedTextTransaction({
        mutations: [
          { current: currentAuthority.authorityFile, next: loaded.authorityFile.text },
          { current: currentAuthority.authorizedKeysFile, next: loaded.authorizedKeysFile.text },
          { current: currentGateway, next: rollbackGateway },
          { current: currentCore, next: coreFile.text },
          { current: currentIdentity, next: identityFile.text },
        ],
      });
    },
  });
}
