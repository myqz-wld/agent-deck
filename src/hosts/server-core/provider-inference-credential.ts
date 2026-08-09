import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';

import {
  ServerCoreProviderInferenceError,
  type ServerCoreProviderInferenceUpstreamTarget,
} from './provider-inference-broker-port';

export interface ServerCoreProviderCredentialInjectorPort {
  isAvailable(target: ServerCoreProviderInferenceUpstreamTarget): Promise<boolean>;
  inject(
    target: ServerCoreProviderInferenceUpstreamTarget,
    headers: Headers,
  ): Promise<void>;
}

export interface ServerCoreGrokCredentialFileOptions {
  readonly allowedUids?: readonly number[];
  readonly nowMs?: () => number;
  readonly path: string;
  readonly readDocument?: () => Promise<unknown>;
}

const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;
const TOKEN = /^[\x21-\x7e]+$/;
const GROK_CREDENTIAL_NAMESPACE = 'xai::cached';
const GROK_AUTH_MODE = 'oauth';
const decoder = new TextDecoder('utf-8', { fatal: true });

function normalizedPath(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value || value === '/' || value.includes('\0')) {
    throw new Error('provider credential path is invalid');
  }
  return value;
}

function same(
  left: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
  right: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.uid === right.uid;
}

async function readPrivateCredentialJson(
  path: string,
  allowedUids: readonly number[],
): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let bytes: Buffer | undefined;
  try {
    if ((await realpath(path)) !== path) throw new Error('credential path is not canonical');
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.size < 2 || before.size > MAX_CREDENTIAL_BYTES ||
        (before.mode & 0o077) !== 0 ||
        (allowedUids.length > 0 && !allowedUids.includes(before.uid))) {
      throw new Error('credential file trust check failed');
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength !== before.size || !same(before, after) ||
        (await realpath(path)) !== path) {
      throw new Error('credential file identity changed');
    }
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch (error) {
    throw new Error('provider credential could not be read safely', { cause: error });
  } finally {
    bytes?.fill(0);
    await handle?.close();
  }
}

function object(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function accessToken(document: unknown, nowMs: number): string | null {
  const root = object(document);
  if (!root) return null;
  const entries = Object.entries(root);
  if (entries.length !== 1 || entries[0]?.[0] !== GROK_CREDENTIAL_NAMESPACE) return null;
  const entry = object(entries[0][1]);
  if (!entry || entry.auth_mode !== GROK_AUTH_MODE || typeof entry.key !== 'string' ||
      entry.key.trim() !== entry.key || entry.key.length === 0 ||
      Buffer.byteLength(entry.key) > MAX_TOKEN_BYTES || !TOKEN.test(entry.key)) return null;
  if (entry.expires_at !== undefined && entry.expires_at !== null) {
    if (typeof entry.expires_at !== 'string') return null;
    const expiresAt = new Date(entry.expires_at).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return null;
  }
  return entry.key;
}

function exactGrokTarget(target: ServerCoreProviderInferenceUpstreamTarget): boolean {
  return target.adapterId === 'grok-build' && target.providerId === 'xai' &&
    target.upstreamId === 'grok-xai' && target.method === 'POST';
}

/** Reads the trusted Grok credential on demand and mutates only the host-side fetch headers. */
export class ServerCoreGrokCredentialFile implements ServerCoreProviderCredentialInjectorPort {
  private readonly nowMs: () => number;
  private readonly readDocument: () => Promise<unknown>;

  constructor(options: ServerCoreGrokCredentialFileOptions) {
    const path = normalizedPath(options.path);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
    const allowedUids = options.allowedUids ?? (currentUid === null ? [] : [0, currentUid]);
    if (allowedUids.length > 4 || allowedUids.some((uid) =>
      !Number.isSafeInteger(uid) || uid < 0)) {
      throw new Error('provider credential owner set is invalid');
    }
    this.nowMs = options.nowMs ?? Date.now;
    this.readDocument = options.readDocument ?? (() => readPrivateCredentialJson(path, allowedUids));
  }

  async isAvailable(target: ServerCoreProviderInferenceUpstreamTarget): Promise<boolean> {
    if (!exactGrokTarget(target)) return false;
    try {
      return accessToken(await this.readDocument(), this.nowMs()) !== null;
    } catch {
      return false;
    }
  }

  async inject(
    target: ServerCoreProviderInferenceUpstreamTarget,
    headers: Headers,
  ): Promise<void> {
    if (!exactGrokTarget(target) || headers.has('authorization')) {
      throw new ServerCoreProviderInferenceError(
        'access-denied',
        'Provider credential injection target was rejected',
      );
    }
    let token: string | null = null;
    try {
      token = accessToken(await this.readDocument(), this.nowMs());
    } catch {}
    if (!token) {
      throw new ServerCoreProviderInferenceError(
        'unavailable',
        'Provider credential is unavailable',
      );
    }
    headers.set('authorization', `Bearer ${token}`);
    headers.set('x-grok-client-mode', 'agent-deck');
  }
}
