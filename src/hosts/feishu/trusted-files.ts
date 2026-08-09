import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';

import { requireAbsolutePath } from '@hosts/linux-runtime/validation';

import { parseFeishuCoreSshConfig, type FeishuCoreSshConfig } from './config';

const MAX_SSH_FILE_BYTES = 1024 * 1024;
const MAX_CORE_CONFIG_BYTES = 64 * 1024;

async function verifyPrivateFile(path: string, maxBytes: number, read: boolean): Promise<Buffer | null> {
  requireAbsolutePath(path, 'Feishu private file');
  const expectedUid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  const before = await lstat(path);
  if (
    !before.isFile() || before.isSymbolicLink() || before.size <= 0 ||
    before.size > maxBytes || (before.mode & 0o777) !== 0o600 ||
    (expectedUid !== null && before.uid !== expectedUid) ||
    (await realpath(path)) !== path
  ) {
    throw new Error('Feishu private file is invalid');
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let scratch: Buffer | null = null;
  try {
    const opened = await handle.stat();
    let bytesRead = 0;
    if (read) {
      scratch = Buffer.allocUnsafe(maxBytes + 1);
      ({ bytesRead } = await handle.read(scratch, 0, scratch.byteLength, 0));
    }
    const after = await lstat(path);
    if (
      opened.dev !== before.dev || opened.ino !== before.ino ||
      after.dev !== opened.dev || after.ino !== opened.ino ||
      opened.size !== before.size || opened.mtimeMs !== before.mtimeMs ||
      (await realpath(path)) !== path ||
      (read && bytesRead !== opened.size)
    ) {
      throw new Error('Feishu private file changed during verification');
    }
    return read && scratch ? Buffer.from(scratch.subarray(0, bytesRead)) : null;
  } finally {
    scratch?.fill(0);
    await handle.close();
  }
}

export async function readFeishuCoreSshConfig(path: string): Promise<FeishuCoreSshConfig> {
  const bytes = await verifyPrivateFile(path, MAX_CORE_CONFIG_BYTES, true);
  if (!bytes) throw new Error('Feishu Core SSH config could not be read');
  try {
    return parseFeishuCoreSshConfig(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    throw new Error('Feishu Core SSH config is invalid', { cause: error });
  } finally {
    bytes.fill(0);
  }
}

export async function assertFeishuCoreSshTrustFiles(
  config: FeishuCoreSshConfig,
): Promise<void> {
  await verifyPrivateFile(config.knownHostsFile, MAX_SSH_FILE_BYTES, false);
  for (const credential of config.credentials) {
    await verifyPrivateFile(credential.identityFile, MAX_SSH_FILE_BYTES, false);
  }
}
