import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PID_CACHE_MS = 5 * 60 * 1000;
const SESSION_CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 512;

export interface CodexHookIdentity {
  session_id: string;
  transcript_path?: string | null;
}

export interface ProcessSnapshot {
  pid: number;
  parentPid: number;
  executable?: string;
  command: string;
}

type HookOrigin = 'sdk' | 'cli';
type ReadProcess = (pid: number) => Promise<ProcessSnapshot | null>;

interface CacheEntry {
  expiresAt: number;
  decision: Promise<boolean>;
}

interface FilterOptions {
  platform?: NodeJS.Platform;
  readProcess?: ReadProcess;
  now?: () => number;
}

export interface CodexDesktopEphemeralFilterLike {
  shouldIgnore(
    body: CodexHookIdentity,
    hookOrigin: HookOrigin,
    externalProcessPid: number | null,
  ): Promise<boolean>;
}

/**
 * Filters hidden Desktop-hosted ephemeral generations while preserving terminal Codex runs.
 *
 * `transcript_path: null` is necessary but not sufficient: a user may intentionally launch an
 * ephemeral Codex run from a terminal. The parent-process check narrows the filter to a Codex
 * app-server owned by ChatGPT/Codex Desktop. Every lookup fails open, and both the session decision
 * and PID classification are cached so a tool-heavy background turn does not repeatedly invoke ps.
 */
export class CodexDesktopEphemeralFilter implements CodexDesktopEphemeralFilterLike {
  private readonly platform: NodeJS.Platform;
  private readonly readProcess: ReadProcess;
  private readonly now: () => number;
  private readonly sessionDecisions = new Map<string, CacheEntry>();
  private readonly pidDecisions = new Map<number, CacheEntry>();

  constructor(opts: FilterOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.readProcess = opts.readProcess ?? ((pid) => readProcessSnapshot(pid, this.platform));
    this.now = opts.now ?? Date.now;
  }

  shouldIgnore(
    body: CodexHookIdentity,
    hookOrigin: HookOrigin,
    externalProcessPid: number | null,
  ): Promise<boolean> {
    if (hookOrigin !== 'cli') return Promise.resolve(false);

    const existing = this.sessionDecisions.get(body.session_id);
    if (existing && existing.expiresAt > this.now()) return existing.decision;

    const explicitEphemeral =
      Object.prototype.hasOwnProperty.call(body, 'transcript_path') &&
      body.transcript_path === null;
    if (externalProcessPid === null || !explicitEphemeral) {
      // The first hook fixes the decision for the whole session. This avoids partial ingestion if
      // an older or inconsistent client omits transcript_path on only some hook events.
      return this.cached(
        this.sessionDecisions,
        body.session_id,
        SESSION_CACHE_MS,
        async () => false,
      );
    }

    return this.cached(
      this.sessionDecisions,
      body.session_id,
      SESSION_CACHE_MS,
      () => this.desktopHostDecision(externalProcessPid),
    );
  }

  private desktopHostDecision(pid: number): Promise<boolean> {
    if (this.platform !== 'darwin' && this.platform !== 'win32') {
      return Promise.resolve(false);
    }
    return this.cached(this.pidDecisions, pid, PID_CACHE_MS, async () => {
      try {
        const child = await this.readProcess(pid);
        if (!child || child.parentPid <= 0) return false;
        const parent = await this.readProcess(child.parentPid);
        if (!parent) return false;
        return isDesktopHostedCodexAppServer(child, parent, this.platform);
      } catch {
        return false;
      }
    });
  }

  private cached<K>(
    cache: Map<K, CacheEntry>,
    key: K,
    ttlMs: number,
    load: () => Promise<boolean>,
  ): Promise<boolean> {
    const now = this.now();
    const existing = cache.get(key);
    if (existing && existing.expiresAt > now) return existing.decision;

    pruneCache(cache, now);
    const decision = Promise.resolve()
      .then(load)
      .catch(() => false);
    cache.set(key, { expiresAt: now + ttlMs, decision });
    trimOldest(cache);
    return decision;
  }
}

export function isDesktopHostedCodexAppServer(
  child: ProcessSnapshot,
  parent: ProcessSnapshot,
  platform: NodeJS.Platform,
): boolean {
  const childText = processText(child);
  if (!/(?:^|[\\/])codex(?:\.exe)?(?:["']?)(?:\s|$)/im.test(childText)) return false;
  if (!/(?:^|\s)app-server(?:\s|$)/i.test(child.command)) return false;

  if (platform === 'darwin') {
    const childBundle = desktopBundleName(childText);
    const parentBundle = desktopBundleName(processText(parent));
    return childBundle !== null && childBundle === parentBundle;
  }

  if (platform === 'win32') {
    const parentExecutable = parent.executable || firstCommandToken(parent.command);
    return /(?:^|[\\/])(?:chatgpt|codex)\.exe$/i.test(stripQuotes(parentExecutable));
  }

  // There is no stable Desktop host contract on other platforms yet. Preserve the hook event.
  return false;
}

function desktopBundleName(text: string): string | null {
  const match = text.match(/(?:^|[\\/])(ChatGPT|Codex)\.app[\\/]Contents[\\/]/im);
  return match?.[1]?.toLowerCase() ?? null;
}

function processText(snapshot: ProcessSnapshot): string {
  return `${snapshot.executable ?? ''}\n${snapshot.command}`;
}

function firstCommandToken(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return '';
  const quoted = trimmed.match(/^(["'])(.*?)\1/);
  return quoted?.[2] ?? trimmed.split(/\s+/, 1)[0] ?? '';
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^["']|["']$/g, '');
}

async function readProcessSnapshot(
  pid: number,
  platform: NodeJS.Platform,
): Promise<ProcessSnapshot | null> {
  if (platform === 'darwin' || platform === 'linux' || platform === 'freebsd') {
    return readPsProcess(pid);
  }
  if (platform === 'win32') return readWindowsProcess(pid);
  return null;
}

async function readPsProcess(pid: number): Promise<ProcessSnapshot | null> {
  const { stdout } = await execFileAsync(
    'ps',
    ['-ww', '-p', String(pid), '-o', 'ppid=', '-o', 'command='],
    { encoding: 'utf8', timeout: 750, maxBuffer: 64 * 1024 },
  );
  const match = String(stdout).match(/^\s*(\d+)\s+([\s\S]*\S)\s*$/);
  if (!match) return null;
  const parentPid = Number(match[1]);
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) return null;
  return { pid, parentPid, command: match[2] };
}

async function readWindowsProcess(pid: number): Promise<ProcessSnapshot | null> {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop`,
    'if ($null -eq $p) { exit 3 }',
    '$o = [PSCustomObject]@{ parentPid = [int]$p.ParentProcessId; executable = [string]$p.ExecutablePath; command = [string]$p.CommandLine }',
    '[Console]::Out.Write(($o | ConvertTo-Json -Compress))',
  ].join('; ');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 1_500, maxBuffer: 64 * 1024 },
  );
  const parsed = JSON.parse(String(stdout).replace(/^\uFEFF/, '')) as {
    parentPid?: unknown;
    executable?: unknown;
    command?: unknown;
  };
  if (typeof parsed.parentPid !== 'number' || !Number.isSafeInteger(parsed.parentPid)) return null;
  return {
    pid,
    parentPid: parsed.parentPid,
    executable: typeof parsed.executable === 'string' ? parsed.executable : undefined,
    command: typeof parsed.command === 'string' ? parsed.command : '',
  };
}

function pruneCache<K>(cache: Map<K, CacheEntry>, now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}

function trimOldest<K>(cache: Map<K, CacheEntry>): void {
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export const codexDesktopEphemeralFilter = new CodexDesktopEphemeralFilter();
