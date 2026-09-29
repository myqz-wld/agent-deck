import { execFile } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, normalize, relative, sep } from 'node:path';
import { promisify } from 'node:util';

import type { ProviderSessionSupervisorServicePort } from './host-service';

export interface ProviderCredentialSyncOptions {
  readonly credentialFile: string;
  readonly workerWrapper: string;
  readonly workerConfigId: string;
  readonly workspaceRoot: string;
  readonly sharedRuntimeRoot: string;
}

interface Dependencies {
  readonly intervalMs?: number;
  readonly run?: (executable: string, args: readonly string[], signal: AbortSignal) => Promise<void>;
  readonly warn?: () => void;
}

const execute = promisify(execFile);
const POLL_INTERVAL_MS = 30_000;

function absolute(path: string): string {
  if (!isAbsolute(path) || normalize(path) !== path || path === '/' ||
      path.length > 4096 || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new Error('Provider credential synchronization path is invalid');
  }
  return path;
}

function within(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function trustedFile(path: string, credential: boolean): string {
  const stat = lstatSync(path, { bigint: true });
  const mode = Number(stat.mode) & 0o777;
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path ||
      ![0, process.getuid?.()].includes(Number(stat.uid)) ||
      (credential ? mode !== 0o600 || stat.size < 2n || stat.size > 1_048_576n
        : (mode & 0o022) !== 0 || (mode & 0o111) === 0)) {
    throw new Error('Provider credential synchronization file is not trusted');
  }
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid].join(':');
}

/** Host-only source watcher. Token parsing and atomic projection remain in the trusted Worker CLI. */
export class ProviderCredentialSync {
  private readonly intervalMs: number;
  private readonly run: NonNullable<Dependencies['run']>;
  private readonly warn: NonNullable<Dependencies['warn']>;
  private active = false;
  private closed = false;
  private warned = false;
  private lastSource: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private pending: Promise<void> | null = null;

  constructor(private readonly options: ProviderCredentialSyncOptions, dependencies: Dependencies = {}) {
    for (const path of [options.credentialFile, options.workerWrapper,
      options.workspaceRoot, options.sharedRuntimeRoot]) absolute(path);
    if (!/^worker-[a-f0-9]{24}$/u.test(options.workerConfigId) ||
        basename(options.workerWrapper) !== 'agent-deck-worker' ||
        [options.workspaceRoot, options.sharedRuntimeRoot].some((root) =>
          within(root, options.credentialFile) || within(root, options.workerWrapper))) {
      throw new Error('Provider credential synchronization overlaps Worker-visible authority');
    }
    this.intervalMs = dependencies.intervalMs ?? POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(this.intervalMs) || this.intervalMs < 1 || this.intervalMs > 60_000) {
      throw new Error('Provider credential synchronization interval is invalid');
    }
    this.run = dependencies.run ?? (async (executable, args, signal) => {
      await execute(executable, [...args], {
        signal, timeout: 30_000, maxBuffer: 64 * 1024,
        env: { HOME: homedir(), PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      });
    });
    this.warn = dependencies.warn ?? (() => process.stderr.write(
      'Grok 凭证同步暂未成功；保留现有副本，并在源登录更新后重试。\n',
    ));
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Provider credential synchronization is closed'));
    if (this.active) return this.pending ?? Promise.resolve();
    this.active = true;
    return this.synchronize();
  }

  async stop(): Promise<void> {
    this.active = false;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    await this.pending;
  }

  private synchronize(): Promise<void> {
    if (!this.active || this.pending) return this.pending ?? Promise.resolve();
    const controller = new AbortController();
    this.controller = controller;
    this.pending = (async () => {
      try {
        const source = trustedFile(this.options.credentialFile, true);
        if (source === this.lastSource) return;
        trustedFile(this.options.workerWrapper, false);
        await this.run(this.options.workerWrapper, [
          'install-provider-credential', '--credential', this.options.credentialFile,
          '--worker', this.options.workerConfigId,
        ], controller.signal);
        if (!controller.signal.aborted) {
          this.lastSource = source;
          this.warned = false;
        }
      } catch {
        if (!controller.signal.aborted && !this.warned) {
          this.warned = true;
          try { this.warn(); } catch { /* Diagnostics never terminate the supervisor. */ }
        }
      }
    })().finally(() => {
      this.pending = null;
      this.controller = null;
      if (this.active) {
        this.timer = setTimeout(() => { void this.synchronize(); }, this.intervalMs);
        this.timer.unref();
      }
    });
    return this.pending;
  }
}

export function withProviderCredentialSync(
  service: ProviderSessionSupervisorServicePort,
  sync: Pick<ProviderCredentialSync, 'start' | 'stop'>,
): ProviderSessionSupervisorServicePort {
  return {
    start: async () => { await sync.start(); await service.start(); },
    stop: async () => { try { await sync.stop(); } finally { await service.stop(); } },
    whenCloseRequested: () => service.whenCloseRequested(),
    whenFailed: () => service.whenFailed(),
  };
}
