import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import {
  renderRemoteConnectionKnownHosts,
  type RemoteConnectionCredential,
} from '@shared/remote-host';

export interface InstalledRemoteHostCredential {
  identityFile: string;
  knownHostsFile: string;
}

export interface RemoteHostCredentialMaterialStore {
  install(credential: RemoteConnectionCredential): InstalledRemoteHostCredential;
  dispose(material: InstalledRemoteHostCredential): void;
}

export interface FileCredentialMaterialStoreOptions {
  root: string;
  createId: () => string;
}

function writeExclusive(path: string, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset);
    fsyncSync(descriptor);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size !== bytes.byteLength) {
      throw new Error('credential material post-write verification failed');
    }
  } finally {
    bytes.fill(0);
    if (descriptor !== null) closeSync(descriptor);
  }
}

export class FileRemoteHostCredentialMaterialStore implements RemoteHostCredentialMaterialStore {
  private readonly root: string;

  constructor(private readonly options: FileCredentialMaterialStoreOptions) {
    if (!isAbsolute(options.root) || resolve(options.root) !== options.root) {
      throw new Error('credential material root must be an absolute normalized path');
    }
    this.root = options.root;
  }

  install(credential: RemoteConnectionCredential): InstalledRemoteHostCredential {
    this.ensureRoot();
    const id = this.options.createId();
    if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) throw new Error('credential material id is invalid');
    const identityFile = resolve(this.root, `identity-${id}.key`);
    const knownHostsFile = resolve(this.root, `known-hosts-${id}.txt`);
    try {
      writeExclusive(
        identityFile,
        credential.identity.privateKey.endsWith('\n')
          ? credential.identity.privateKey
          : `${credential.identity.privateKey}\n`,
      );
      writeExclusive(knownHostsFile, renderRemoteConnectionKnownHosts(credential));
      this.syncRoot();
      return { identityFile, knownHostsFile };
    } catch (error) {
      this.removeOwned(identityFile);
      this.removeOwned(knownHostsFile);
      throw error;
    }
  }

  dispose(material: InstalledRemoteHostCredential): void {
    if (!existsSync(this.root)) return;
    this.ensureRoot();
    this.removeOwned(material.identityFile);
    this.removeOwned(material.knownHostsFile);
    this.syncRoot();
  }

  private ensureRoot(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (realpathSync(this.root) !== this.root) throw new Error('credential material root is not canonical');
    const stat = lstatSync(this.root);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (currentUid !== null && stat.uid !== currentUid)) {
      throw new Error('credential material root trust check failed');
    }
    if ((stat.mode & 0o777) !== 0o700) chmodSync(this.root, 0o700);
  }

  private removeOwned(path: string): void {
    if (dirname(path) !== this.root || !/^(?:identity|known-hosts)-[A-Za-z0-9-]{1,128}\.(?:key|txt)$/.test(basename(path))) {
      return;
    }
    let stat;
    try { stat = lstatSync(path); } catch { return; }
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    unlinkSync(path);
  }

  private syncRoot(): void {
    let descriptor: number | null = null;
    try {
      descriptor = openSync(this.root, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
      fsyncSync(descriptor);
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
  }
}
