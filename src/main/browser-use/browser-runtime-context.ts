import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join, resolve, sep } from 'node:path';

import type { RuntimeAdapterId } from '@shared/types';

import {
  BROWSER_LEASE_MAX_TTL_MS,
  type BrowserLeaseRegistryCore,
} from './browser-lease-registry-core';

export const BROWSER_RUNTIME_KEY_ENV = 'AGENT_DECK_BROWSER_RUNTIME_KEY';
export const BROWSER_RUNTIME_BIN_ENV = 'AGENT_DECK_BROWSER_BIN_DIR';
export const BROWSER_CONTEXT_FILE_ENV = 'AGENT_DECK_BROWSER_CONTEXT_FILE';

export interface BrowserRuntimeContextManagerOptions {
  readonly rootDir: string;
  readonly brokerEndpoint: string;
  readonly executablePath: string;
  readonly cliPath: string;
  readonly registry: BrowserLeaseRegistryCore;
  readonly platform?: NodeJS.Platform;
}

export interface PrepareBrowserRuntimeContextOptions {
  readonly applicationSessionId: string;
  readonly adapterId: RuntimeAdapterId;
  readonly environment: Readonly<Record<string, string>>;
}

export interface PreparedBrowserRuntimeContext {
  readonly runtimeKey: string;
  readonly runtimeGeneration: number;
  readonly runtimeDir: string;
  readonly binDir: string;
  readonly contextPath: string;
  readonly commandPath: string;
  readonly environment: Record<string, string>;
}

interface RuntimeRecord {
  readonly runtimeKey: string;
  runtimeGeneration: number;
  readonly runtimeDir: string;
  readonly binDir: string;
  readonly contextPath: string;
  readonly commandPath: string;
  readonly environment: Record<string, string>;
  applicationSessionId: string;
  readonly adapterId: RuntimeAdapterId;
  sourceIdentity: string;
  lease: string;
}

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function windowsQuote(value: string): string {
  return `"${value.replaceAll('%', '%%').replaceAll('"', '""')}"`;
}

function pathKey(environment: Readonly<Record<string, string>>, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return 'PATH';
  const matches = Object.keys(environment).filter((key) => key.toLowerCase() === 'path');
  return matches.includes('Path') ? 'Path' : (matches.at(-1) ?? 'Path');
}

function prependPath(
  environment: Readonly<Record<string, string>>,
  binDir: string,
  platform: NodeJS.Platform,
): Record<string, string> {
  const result = { ...environment };
  const key = pathKey(result, platform);
  if (platform === 'win32') {
    for (const candidate of Object.keys(result)) {
      if (candidate !== key && candidate.toLowerCase() === 'path') delete result[candidate];
    }
  }
  const separator = platform === 'win32' ? ';' : delimiter;
  const current = result[key] ?? '';
  const entries = current.split(separator).filter(Boolean).filter((entry) => entry !== binDir);
  result[key] = [binDir, ...entries].join(separator);
  return result;
}

/** Owns private runtime directories, command shims, context rotation, and lease lifecycle. */
export class BrowserRuntimeContextManager {
  private readonly rootDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly recordsByKey = new Map<string, RuntimeRecord>();
  private readonly keyBySession = new Map<string, string>();

  constructor(private readonly options: BrowserRuntimeContextManagerOptions) {
    this.platform = options.platform ?? process.platform;
    this.rootDir = resolve(options.rootDir);
    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    chmodSync(this.rootDir, 0o700);
    const rootStat = lstatSync(this.rootDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('Browser runtime root is unavailable.');
    }
    if (typeof process.getuid === 'function' && rootStat.uid !== process.getuid()) {
      throw new Error('Browser runtime root is unavailable.');
    }
    this.reapStaleDirectories();
  }

  prepare(input: PrepareBrowserRuntimeContextOptions): PreparedBrowserRuntimeContext {
    this.revokeSession(input.applicationSessionId);
    const runtimeKey = randomUUID();
    const runtimeDir = mkdtempSync(join(this.rootDir, 'runtime-'));
    const binDir = join(runtimeDir, 'bin');
    const contextPath = join(runtimeDir, 'context.json');
    const commandPath = join(
      binDir,
      this.platform === 'win32' ? 'agent-deck-browser.cmd' : 'agent-deck-browser',
    );
    const sourceIdentity = randomUUID();
    mkdirSync(binDir, { mode: 0o700 });
    chmodSync(runtimeDir, 0o700);
    chmodSync(binDir, 0o700);

    const identity = {
      applicationSessionId: input.applicationSessionId,
      adapterId: input.adapterId,
      runtimeGeneration: 1,
      sourceIdentity,
    } as const;
    const issued = this.options.registry.issue(identity, BROWSER_LEASE_MAX_TTL_MS);
    try {
      this.writeContext(contextPath, {
        protocolVersion: 1,
        endpoint: this.options.brokerEndpoint,
        lease: issued.lease,
        adapterId: input.adapterId,
        runtimeGeneration: 1,
        sourceIdentity,
      });
      this.writeCommand(commandPath, contextPath);
    } catch (error) {
      this.options.registry.revoke(issued.lease);
      rmSync(runtimeDir, { recursive: true, force: true });
      throw error;
    }

    const environment = prependPath(input.environment, binDir, this.platform);
    environment[BROWSER_RUNTIME_KEY_ENV] = runtimeKey;
    environment[BROWSER_RUNTIME_BIN_ENV] = binDir;
    const record: RuntimeRecord = {
      runtimeKey,
      runtimeGeneration: 1,
      runtimeDir,
      binDir,
      contextPath,
      commandPath,
      environment,
      applicationSessionId: input.applicationSessionId,
      adapterId: input.adapterId,
      sourceIdentity,
      lease: issued.lease,
    };
    this.recordsByKey.set(runtimeKey, record);
    this.keyBySession.set(input.applicationSessionId, runtimeKey);
    return this.publicRecord(record);
  }

  refresh(runtimeKey: string): PreparedBrowserRuntimeContext {
    const record = this.recordsByKey.get(runtimeKey);
    if (record == null) throw new Error('Browser runtime context is unavailable.');
    const runtimeGeneration = record.runtimeGeneration + 1;
    const sourceIdentity = randomUUID();
    this.options.registry.revoke(record.lease);
    const issued = this.options.registry.issue({
      applicationSessionId: record.applicationSessionId,
      adapterId: record.adapterId,
      runtimeGeneration,
      sourceIdentity,
    }, BROWSER_LEASE_MAX_TTL_MS);
    try {
      this.writeContext(record.contextPath, {
        protocolVersion: 1,
        endpoint: this.options.brokerEndpoint,
        lease: issued.lease,
        adapterId: record.adapterId,
        runtimeGeneration,
        sourceIdentity,
      });
    } catch (error) {
      this.options.registry.revoke(issued.lease);
      throw error;
    }
    record.runtimeGeneration = runtimeGeneration;
    record.sourceIdentity = sourceIdentity;
    record.lease = issued.lease;
    return this.publicRecord(record);
  }

  renameSession(fromApplicationSessionId: string, toApplicationSessionId: string): number {
    if (fromApplicationSessionId === toApplicationSessionId) return 0;
    const runtimeKey = this.keyBySession.get(fromApplicationSessionId);
    if (runtimeKey == null) return 0;
    const record = this.recordsByKey.get(runtimeKey);
    if (record == null) return 0;
    this.revokeSession(toApplicationSessionId);
    this.options.registry.renameSession(fromApplicationSessionId, toApplicationSessionId);
    this.keyBySession.delete(fromApplicationSessionId);
    this.keyBySession.set(toApplicationSessionId, runtimeKey);
    record.applicationSessionId = toApplicationSessionId;
    return 1;
  }

  revokeRuntime(runtimeKey: string, expectedGeneration?: number): boolean {
    const record = this.recordsByKey.get(runtimeKey);
    if (record == null) return false;
    if (
      expectedGeneration !== undefined &&
      record.runtimeGeneration !== expectedGeneration
    ) return false;
    return this.removeRecord(record);
  }

  revokeSession(applicationSessionId: string): number {
    const runtimeKey = this.keyBySession.get(applicationSessionId);
    if (runtimeKey == null) return 0;
    const record = this.recordsByKey.get(runtimeKey);
    return record != null && this.removeRecord(record) ? 1 : 0;
  }

  shutdown(): number {
    const records = [...this.recordsByKey.values()];
    for (const record of records) this.removeRecord(record);
    return records.length;
  }

  private publicRecord(record: RuntimeRecord): PreparedBrowserRuntimeContext {
    return {
      runtimeKey: record.runtimeKey,
      runtimeGeneration: record.runtimeGeneration,
      runtimeDir: record.runtimeDir,
      binDir: record.binDir,
      contextPath: record.contextPath,
      commandPath: record.commandPath,
      environment: { ...record.environment },
    };
  }

  private removeRecord(record: RuntimeRecord): boolean {
    if (this.recordsByKey.get(record.runtimeKey) !== record) return false;
    this.recordsByKey.delete(record.runtimeKey);
    if (this.keyBySession.get(record.applicationSessionId) === record.runtimeKey) {
      this.keyBySession.delete(record.applicationSessionId);
    }
    this.options.registry.revoke(record.lease);
    const prefix = this.rootDir.endsWith(sep) ? this.rootDir : `${this.rootDir}${sep}`;
    if (record.runtimeDir.startsWith(prefix) && existsSync(record.runtimeDir)) {
      rmSync(record.runtimeDir, { recursive: true, force: true });
    }
    return true;
  }

  private writeContext(contextPath: string, value: Record<string, unknown>): void {
    const temporary = `${contextPath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    chmodSync(temporary, 0o600);
    try {
      renameSync(temporary, contextPath);
    } catch (error) {
      if (this.platform !== 'win32') throw error;
      try { unlinkSync(contextPath); } catch {}
      renameSync(temporary, contextPath);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
    chmodSync(contextPath, 0o600);
  }

  private writeCommand(commandPath: string, contextPath: string): void {
    const content = this.platform === 'win32'
      ? [
          '@echo off',
          `set "${BROWSER_CONTEXT_FILE_ENV}=${contextPath}"`,
          'set "ELECTRON_RUN_AS_NODE=1"',
          `${windowsQuote(this.options.executablePath)} ${windowsQuote(this.options.cliPath)} %*`,
          '',
        ].join('\r\n')
      : [
          '#!/bin/sh',
          `${BROWSER_CONTEXT_FILE_ENV}=${posixQuote(contextPath)}`,
          `export ${BROWSER_CONTEXT_FILE_ENV}`,
          'ELECTRON_RUN_AS_NODE=1',
          'export ELECTRON_RUN_AS_NODE',
          `exec ${posixQuote(this.options.executablePath)} ${posixQuote(this.options.cliPath)} "$@"`,
          '',
        ].join('\n');
    writeFileSync(commandPath, content, { flag: 'wx', mode: 0o700 });
    chmodSync(commandPath, 0o700);
  }

  private reapStaleDirectories(): void {
    const cutoff = Date.now() - 24 * 60 * 60_000;
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    for (const entry of readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!/^runtime-[A-Za-z0-9]{6}$/.test(entry.name) || !entry.isDirectory()) continue;
      const candidate = join(this.rootDir, entry.name);
      try {
        const candidateStat = lstatSync(candidate);
        if (
          candidateStat.isSymbolicLink() ||
          !candidateStat.isDirectory() ||
          (uid != null && candidateStat.uid !== uid) ||
          (candidateStat.mode & 0o077) !== 0 ||
          candidateStat.mtimeMs >= cutoff
        ) continue;
        rmSync(candidate, { recursive: true, force: true });
      } catch {
        // Unknown, raced, or insufficiently constrained paths remain untouched.
      }
    }
  }
}
