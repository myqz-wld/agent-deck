'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const SANDBOX_META_KEY = 'codex/sandbox-state-meta';
const LEGACY_ERROR = /codex\/sandbox-state-meta[\s\S]*missing field [`'\"]sandboxPolicy[`'\"]/i;

function decodeTarget(encoded) {
  let target;
  try {
    target = JSON.parse(Buffer.from(encoded || '', 'base64url').toString('utf8'));
  } catch {
    throw new Error('invalid target payload');
  }
  if (!target || typeof target.command !== 'string' || target.command.trim() === '') {
    throw new Error('target command is missing');
  }
  if (!Array.isArray(target.args) || target.args.some((arg) => typeof arg !== 'string')) {
    throw new Error('target args must be a string array');
  }
  return target;
}

function sandboxCwdToNativePath(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('sandboxCwd is missing');
  }
  let nativePath = value;
  if (value.startsWith('file:')) {
    try {
      nativePath = fileURLToPath(value);
    } catch {
      throw new Error('sandboxCwd is not a usable file URI');
    }
  }
  if (!path.isAbsolute(nativePath) || nativePath.includes('\0')) {
    throw new Error('sandboxCwd must resolve to an absolute native path');
  }
  return nativePath;
}

function permissionProfileToLegacySandboxPolicy(profile, sandboxCwd) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new Error('permissionProfile is missing');
  }
  if (profile.type === 'disabled') return { type: 'danger-full-access' };
  if (profile.type === 'external') {
    return {
      type: 'external-sandbox',
      network_access: networkAccessName(profile.network),
    };
  }
  if (profile.type !== 'managed') {
    throw new Error(`unsupported permissionProfile type: ${String(profile.type)}`);
  }

  const networkEnabled = readNetworkEnabled(profile.network);
  const fileSystem = profile.file_system;
  if (!fileSystem || typeof fileSystem !== 'object' || Array.isArray(fileSystem)) {
    throw new Error('managed permissionProfile.file_system is missing');
  }
  if (fileSystem.type === 'unrestricted') {
    return networkEnabled
      ? { type: 'danger-full-access' }
      : { type: 'external-sandbox', network_access: 'restricted' };
  }
  if (fileSystem.type !== 'restricted' || !Array.isArray(fileSystem.entries)) {
    throw new Error(`unsupported managed file_system type: ${String(fileSystem.type)}`);
  }

  const cwd = sandboxCwdToNativePath(sandboxCwd);
  return restrictedProfileToLegacyPolicy(fileSystem.entries, cwd, networkEnabled);
}

function restrictedProfileToLegacyPolicy(entries, cwd, networkEnabled) {
  if (!hasFullDiskReadAccess(entries)) {
    throw new Error('restricted filesystem reads cannot be represented safely');
  }
  if (hasFullDiskWriteAccess(entries)) {
    return networkEnabled
      ? { type: 'danger-full-access' }
      : { type: 'external-sandbox', network_access: 'restricted' };
  }

  let workspaceRootWritable = false;
  let tmpdirWritable = false;
  let slashTmpWritable = false;
  let unbridgeableRootWrite = false;
  const writableRoots = [];

  for (const entry of entries) {
    if (!isEntry(entry) || entry.access !== 'write') continue;
    const entryPath = entry.path;
    if (entryPath.type === 'glob_pattern') continue;
    if (entryPath.type === 'path') {
      const absolute = readAbsolutePath(entryPath.path, 'write entry path');
      if (samePath(absolute, cwd)) workspaceRootWritable = true;
      else writableRoots.push(absolute);
      continue;
    }
    if (entryPath.type !== 'special' || !isRecord(entryPath.value)) continue;
    const special = entryPath.value;
    if (special.kind === 'root') unbridgeableRootWrite = true;
    else if (special.kind === 'project_roots') {
      if (special.subpath === null || special.subpath === undefined) {
        workspaceRootWritable = true;
      } else if (typeof special.subpath === 'string') {
        writableRoots.push(path.resolve(cwd, special.subpath));
      }
    } else if (special.kind === 'tmpdir') {
      tmpdirWritable = true;
    } else if (special.kind === 'slash_tmp') {
      slashTmpWritable = true;
    }
  }

  if (workspaceRootWritable) {
    const policy = {
      type: 'workspace-write',
      network_access: networkEnabled,
      exclude_tmpdir_env_var: !tmpdirWritable,
      exclude_slash_tmp: !slashTmpWritable,
    };
    const roots = dedupePaths(writableRoots);
    if (roots.length > 0) policy.writable_roots = roots;
    return policy;
  }
  if (unbridgeableRootWrite || writableRoots.length > 0 || tmpdirWritable || slashTmpWritable) {
    throw new Error('filesystem writes outside the workspace root cannot be represented safely');
  }
  return networkEnabled
    ? { type: 'read-only', network_access: true }
    : { type: 'read-only' };
}

function hasFullDiskReadAccess(entries) {
  const rootReadable = entries.some((entry) =>
    isSpecialEntry(entry, 'root', 'read') || isSpecialEntry(entry, 'root', 'write'));
  return rootReadable && !entries.some((entry) => isEntry(entry) && entry.access === 'deny');
}

function hasFullDiskWriteAccess(entries) {
  const rootWrite = entries.some((entry) => isSpecialEntry(entry, 'root', 'write'));
  if (!rootWrite) return false;
  return !entries.some((entry) => isWriteNarrowingEntry(entry, entries));
}

function isWriteNarrowingEntry(entry, entries) {
  if (!isEntry(entry) || entry.access === 'write') return false;
  if (entry.path.type === 'glob_pattern') return true;
  if (entry.path.type === 'path') return !hasSameTargetWrite(entry, entries);
  if (entry.path.type !== 'special' || !isRecord(entry.path.value)) return true;
  const kind = entry.path.value.kind;
  if (kind === 'root') return entry.access === 'deny';
  if (kind === 'minimal' || kind === 'unknown') return false;
  return !hasSameTargetWrite(entry, entries);
}

function hasSameTargetWrite(entry, entries) {
  return entries.some((candidate) =>
    isEntry(candidate) && candidate.access === 'write' && pathsShareTarget(candidate.path, entry.path));
}

function pathsShareTarget(left, right) {
  if (!isRecord(left) || !isRecord(right) || left.type !== right.type) return false;
  if (left.type === 'path') return left.path === right.path;
  if (left.type === 'glob_pattern') return left.pattern === right.pattern;
  if (left.type !== 'special' || !isRecord(left.value) || !isRecord(right.value)) return false;
  return left.value.kind === right.value.kind && left.value.subpath === right.value.subpath;
}

function patchLegacySandboxState(request) {
  const state = request?.params?._meta?.[SANDBOX_META_KEY];
  if (!isRecord(state)) throw new Error(`${SANDBOX_META_KEY} is missing`);
  if (isRecord(state.sandboxPolicy)) return request;
  const sandboxCwd = sandboxCwdToNativePath(state.sandboxCwd);
  const sandboxPolicy = permissionProfileToLegacySandboxPolicy(
    state.permissionProfile,
    state.sandboxCwd,
  );
  return {
    ...request,
    params: {
      ...request.params,
      _meta: {
        ...request.params._meta,
        [SANDBOX_META_KEY]: { ...state, sandboxPolicy, sandboxCwd },
      },
    },
  };
}

function isLegacySandboxPolicyError(message) {
  return isRecord(message?.error)
    && message.error.code === -32602
    && typeof message.error.message === 'string'
    && LEGACY_ERROR.test(message.error.message);
}

function isEligibleToolCall(message) {
  const state = message?.params?._meta?.[SANDBOX_META_KEY];
  return message?.method === 'tools/call'
    && Object.prototype.hasOwnProperty.call(message, 'id')
    && isRecord(state)
    && !isRecord(state.sandboxPolicy);
}

function startProxy(target) {
  const targetEnv = { ...process.env };
  delete targetEnv.ELECTRON_RUN_AS_NODE;
  if (typeof target.electronRunAsNode === 'string') {
    targetEnv.ELECTRON_RUN_AS_NODE = target.electronRunAsNode;
  }
  const child = spawn(target.command, target.args, { env: targetEnv, stdio: 'pipe' });
  const pending = new Map();
  let legacyMode = false;

  relayLines(process.stdin, (line) => {
    const parsed = parseLine(line);
    if (!parsed) return writeLine(child.stdin, line);
    if (isEligibleToolCall(parsed)) {
      const key = requestIdKey(parsed.id);
      if (legacyMode) {
        try {
          const patched = patchLegacySandboxState(parsed);
          pending.set(key, { request: parsed, retried: true });
          return writeMessage(child.stdin, patched);
        } catch (err) {
          return writeMessage(process.stdout, compatibilityError(parsed, err));
        }
      }
      pending.set(key, { request: parsed, retried: false });
    }
    writeMessage(child.stdin, parsed);
  }, () => child.stdin.end());

  relayLines(child.stdout, (line) => {
    const parsed = parseLine(line);
    if (!parsed || !Object.prototype.hasOwnProperty.call(parsed, 'id')) {
      return writeLine(process.stdout, line);
    }
    const key = requestIdKey(parsed.id);
    const candidate = pending.get(key);
    if (candidate && !candidate.retried && isLegacySandboxPolicyError(parsed)) {
      legacyMode = true;
      try {
        const patched = patchLegacySandboxState(candidate.request);
        pending.set(key, { request: candidate.request, retried: true });
        return writeMessage(child.stdin, patched);
      } catch (err) {
        pending.delete(key);
        return writeMessage(process.stdout, compatibilityError(candidate.request, err));
      }
    }
    if (candidate && (Object.prototype.hasOwnProperty.call(parsed, 'result') || parsed.error)) {
      pending.delete(key);
    }
    writeMessage(process.stdout, parsed);
  });

  child.stderr.pipe(process.stderr);
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    process.exitCode = code;
    process.stdin.destroy();
  };
  child.on('error', (err) => {
    process.stderr.write(`Agent Deck node_repl proxy failed to start target: ${err.message}\n`);
    finish(1);
  });
  child.on('exit', (code, signal) => {
    finish(typeof code === 'number' ? code : signal ? 1 : 0);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }
}

function compatibilityError(request, err) {
  const detail = err instanceof Error ? err.message : String(err);
  return {
    jsonrpc: typeof request.jsonrpc === 'string' ? request.jsonrpc : '2.0',
    id: request.id,
    error: {
      code: -32602,
      message: `Agent Deck 无法将 permissionProfile 安全转换为 legacy sandboxPolicy: ${detail}`,
    },
  };
}

function relayLines(stream, onLine, onEnd) {
  stream.setEncoding('utf8');
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) onLine(line);
    }
  });
  stream.on('end', () => {
    if (buffer.length > 0) onLine(buffer.replace(/\r$/, ''));
    if (onEnd) onEnd();
  });
}

function parseLine(line) {
  try {
    const parsed = JSON.parse(line);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeMessage(stream, message) {
  stream.write(`${JSON.stringify(message)}\n`);
}

function writeLine(stream, line) {
  stream.write(`${line}\n`);
}

function requestIdKey(id) {
  return `${typeof id}:${String(id)}`;
}

function readNetworkEnabled(value) {
  if (value === 'enabled') return true;
  if (value === 'restricted') return false;
  throw new Error(`unsupported network policy: ${String(value)}`);
}

function networkAccessName(value) {
  return readNetworkEnabled(value) ? 'enabled' : 'restricted';
}

function readAbsolutePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${label} must be an absolute native path`);
  }
  return value;
}

function samePath(left, right) {
  return path.resolve(left) === path.resolve(right);
}

function dedupePaths(paths) {
  const seen = new Set();
  return paths.filter((item) => {
    if (seen.has(item)) return false;
    seen.add(item);
    return true;
  });
}

function isEntry(value) {
  return isRecord(value)
    && (value.access === 'read' || value.access === 'write' || value.access === 'deny')
    && isRecord(value.path);
}

function isSpecialEntry(entry, kind, access) {
  return isEntry(entry)
    && entry.access === access
    && entry.path.type === 'special'
    && isRecord(entry.path.value)
    && entry.path.value.kind === kind;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

if (require.main === module) {
  try {
    startProxy(decodeTarget(process.argv[2]));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Agent Deck node_repl proxy configuration error: ${detail}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  decodeTarget,
  isLegacySandboxPolicyError,
  patchLegacySandboxState,
  permissionProfileToLegacySandboxPolicy,
  sandboxCwdToNativePath,
};
