import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { AtomicPrivateStateFile } from '@hosts/linux-runtime/atomic-state-file';
import { readPrivateJsonFile } from '@hosts/linux-runtime/config-file';
import {
  isValidServerCoreGrokCredentialDocument,
} from '@hosts/server-core/provider-inference-credential';

const GROK_CREDENTIAL_FILE = 'grok-auth.json';
const MAX_GROK_CREDENTIAL_BYTES = 1024 * 1024;

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    resolve(path) !== path || realpathSync(path) !== path ||
    !stat.isDirectory() || stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o700 || (uid !== null && stat.uid !== uid)
  ) {
    throw new Error('Worker Provider credential directory is invalid');
  }
}

export async function readLocalWorkerGrokCredential(
  credentialFile: string,
): Promise<unknown> {
  const stat = lstatSync(credentialFile);
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (
    resolve(credentialFile) !== credentialFile || realpathSync(credentialFile) !== credentialFile ||
    !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 ||
    (uid !== null && stat.uid !== uid && stat.uid !== 0)
  ) {
    throw new Error('Grok Provider credential file must be canonical private mode 0600');
  }
  const document = await readPrivateJsonFile(credentialFile, {
    maxBytes: MAX_GROK_CREDENTIAL_BYTES,
  });
  if (!isValidServerCoreGrokCredentialDocument(document)) {
    throw new Error('Grok Provider credential document is invalid or expired');
  }
  return document;
}

/** Projects the exact Grok credential into one Worker's model-invisible private root. */
export async function installLocalWorkerGrokCredential(
  privateRoot: string,
  credentialFile: string,
): Promise<string> {
  assertPrivateDirectory(privateRoot);
  const document = await readLocalWorkerGrokCredential(credentialFile);
  const credentialRoot = join(privateRoot, 'provider-inference');
  mkdirSync(credentialRoot, { recursive: true, mode: 0o700 });
  assertPrivateDirectory(credentialRoot);
  const target = join(credentialRoot, GROK_CREDENTIAL_FILE);
  const encoded = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  try {
    await new AtomicPrivateStateFile(target, MAX_GROK_CREDENTIAL_BYTES).write(encoded);
  } finally {
    encoded.fill(0);
  }
  return target;
}
