import { preflightNodeNativeSqlite } from '@hosts/daemon/sqlite-preflight';
import { parseExactFlags } from '@hosts/linux-runtime/validation';
import { loadFeishuProductionConfig } from '@gateways/feishu/config';
import type { FeishuAuditSink } from '@gateways/feishu/types';

import { createFeishuSshClientFactory } from './client-factory';
import { FeishuManagementServer } from './management-server';
import { runFeishuService } from './service';
import {
  assertFeishuCoreSshTrustFiles,
  readFeishuCoreSshConfig,
} from './trusted-files';

const SAFE_AUDIT_TEXT = /^[A-Za-z0-9._:-]{1,128}$/;

const auditSink: FeishuAuditSink = (entry) => {
  const fields = [entry.component, entry.operation, entry.outcome, entry.code];
  const safe = fields.every((field) => SAFE_AUDIT_TEXT.test(field));
  process.stderr.write(`${JSON.stringify(safe
    ? { component: entry.component, operation: entry.operation, outcome: entry.outcome, code: entry.code }
    : { component: 'runtime', operation: 'audit', outcome: 'rejected', code: 'redacted' })}\n`);
};

async function configurations(flags: Readonly<Record<string, string>>) {
  const gateway = loadFeishuProductionConfig(flags['--config']);
  const ssh = await readFeishuCoreSshConfig(flags['--core-ssh-config']);
  if (gateway.instanceId !== ssh.instanceId || gateway.topology !== ssh.topology) {
    throw new Error('Feishu configuration bindings do not match');
  }
  return { gateway, ssh };
}

async function run(argv: readonly string[]): Promise<number> {
  const command = argv[0] ?? 'serve';
  if (command === 'check-abi') {
    if (argv.length !== 1) throw new Error('check-abi does not accept arguments');
    preflightNodeNativeSqlite();
    return 0;
  }
  if (command !== 'serve' && command !== 'check-config') {
    throw new Error('unknown Feishu host command');
  }
  const flags = parseExactFlags(argv.slice(1), ['--config', '--core-ssh-config']);
  const { gateway, ssh } = await configurations(flags);
  const clientFactory = createFeishuSshClientFactory(gateway, ssh);
  if (command === 'check-config') return 0;
  preflightNodeNativeSqlite();
  await assertFeishuCoreSshTrustFiles(ssh);
  const { createLoadedFeishuRuntime } = await import('@gateways/feishu/runtime');
  return (await runFeishuService(
    (onFatal) => createLoadedFeishuRuntime(gateway, {
      appVersion: ssh.appVersion,
      clientFactory,
      auditSink,
      onFatal,
    }),
    undefined,
    (runtime, onFatal) => new FeishuManagementServer({
      socketPath: gateway.managementSocketPath,
      instanceId: gateway.instanceId,
      topology: gateway.topology,
      target: runtime.managementTarget(),
      coreStatus: () => runtime.coreStatus(),
      verifyCore: () => runtime.verifyCore(),
      now: () => Date.now(),
      onFatal,
    }),
  )).exitCode;
}

const entrypointArgv = process.argv.slice(2);
void run(entrypointArgv).then(
  (code) => { process.exitCode = code; },
  () => {
    process.stderr.write(entrypointArgv[0] === 'check-abi'
      ? '飞书服务的 Node SQLite ABI 预检失败。\n'
      : '飞书服务启动失败；详细输入已隐藏。\n');
    process.exitCode = 1;
  },
);
