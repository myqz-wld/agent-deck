import type { InstancePaths } from './paths';
import type { CommandPort, ManagerLimits, ManagedTopology, TrustedFileArtifact } from './types';
import type { InstanceManagerContext } from './context';
import { captureTrustedFile } from './artifacts';
import { fail, validateArgv } from './validation';

const BASH = '/usr/bin/bash';
const RELAY_STATIC_SUCCESS =
  'relay preflight: static exact-template checks passed; runtime gates remain unverified\n';
const RELAY_RUNTIME_SUCCESS =
  'relay preflight: runtime identity, health scheduler, and external egress/quota acceptance gates passed\n';

async function runExact(
  commands: CommandPort,
  limits: ManagerLimits,
  args: readonly string[],
  expectedStdout: string,
  trustedArtifacts: readonly TrustedFileArtifact[],
  environment?: Readonly<Record<string, string>>,
): Promise<void> {
  validateArgv(BASH, args);
  const result = await commands.run({
    executable: BASH,
    args,
    timeoutMs: limits.commandTimeoutMs,
    maxOutputBytes: limits.maxOutputBytes,
    environment,
    trustedArtifacts,
  });
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.outputTruncated ||
    result.stdout !== expectedStdout ||
    result.stderr !== ''
  ) {
    fail('command_failed', `topology preflight failed safely (exit ${result.exitCode})`);
  }
}

export async function validateTemplateAndRendered(input: {
  readonly topology: ManagedTopology;
  readonly paths: InstancePaths;
  readonly renderedArtifactPath: string;
  readonly context: InstanceManagerContext;
}): Promise<void> {
  const preflight = await captureTrustedFile(input.context.ports.fileSystem, input.paths.preflightPath, input.context.limits.maxArtifactBytes, input.context.trustedArtifactUid, 0o555, 'topology preflight');
  const template = await captureTrustedFile(input.context.ports.fileSystem, input.paths.templatePath, input.context.limits.maxArtifactBytes, input.context.trustedArtifactUid, 0o444, 'Quadlet template');
  const rendered = await captureTrustedFile(input.context.ports.fileSystem, input.renderedArtifactPath, input.context.limits.maxArtifactBytes, input.context.serviceUid, 0o444, 'rendered Quadlet');
  if (input.topology === 'full') {
    await runExact(input.context.ports.commands, input.context.limits, [input.paths.preflightPath, '--template', input.paths.templatePath], '', [preflight, template]);
    await runExact(
      input.context.ports.commands,
      input.context.limits,
      [input.paths.preflightPath, '--rendered', input.renderedArtifactPath],
      '',
      [preflight, rendered],
    );
    return;
  }
  await runExact(
    input.context.ports.commands,
    input.context.limits,
    [input.paths.preflightPath, '--quadlet', input.paths.templatePath, '--static-only'],
    RELAY_STATIC_SUCCESS,
    [preflight, template],
  );
  await runExact(
    input.context.ports.commands,
    input.context.limits,
    [input.paths.preflightPath, '--quadlet', input.renderedArtifactPath, '--static-only'],
    RELAY_STATIC_SUCCESS,
    [preflight, rendered],
  );
}

export async function runStartPreflight(input: {
  readonly topology: ManagedTopology;
  readonly paths: InstancePaths;
  readonly renderedArtifactPath: string;
  readonly egressEvidencePath: string;
  readonly quotaEvidencePath: string;
  readonly context: InstanceManagerContext;
}): Promise<void> {
  const preflight = await captureTrustedFile(input.context.ports.fileSystem, input.paths.preflightPath, input.context.limits.maxArtifactBytes, input.context.trustedArtifactUid, 0o555, 'topology preflight');
  const rendered = await captureTrustedFile(input.context.ports.fileSystem, input.renderedArtifactPath, input.context.limits.maxArtifactBytes, input.context.serviceUid, 0o444, 'rendered Quadlet');
  const evidenceUid = input.topology === 'full' ? input.context.serviceUid : input.context.trustedRootUid;
  const egress = await captureTrustedFile(input.context.ports.fileSystem, input.egressEvidencePath, 8_192, evidenceUid, 0o444, 'egress evidence');
  const quota = await captureTrustedFile(input.context.ports.fileSystem, input.quotaEvidencePath, 8_192, evidenceUid, 0o444, 'quota evidence');
  if (input.topology === 'full') {
    await runExact(
      input.context.ports.commands,
      input.context.limits,
      [input.paths.preflightPath, '--host', input.renderedArtifactPath],
      '',
      [preflight, rendered, egress, quota],
      {
        AGENT_DECK_EGRESS_ENFORCEMENT: 'verified-egress-gateway',
        AGENT_DECK_VOLUME_QUOTA_READY: 'verified',
      },
    );
    return;
  }
  if (!input.paths.stateDirectory) fail('tampered', 'relay state path is missing');
  await runExact(
    input.context.ports.commands,
    input.context.limits,
    [
      input.paths.preflightPath,
      '--quadlet',
      input.renderedArtifactPath,
      '--instance',
      input.paths.instanceId,
      '--state-dir',
      input.paths.stateDirectory,
      '--config-file',
      input.paths.configFile,
      '--control-dir',
      input.paths.runtimeDirectory,
      '--egress-verification',
      input.egressEvidencePath,
      '--quota-verification',
      input.quotaEvidencePath,
    ],
    RELAY_RUNTIME_SUCCESS,
    [preflight, rendered, egress, quota],
  );
}
