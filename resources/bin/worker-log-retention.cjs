'use strict';

// Dependency-free: this runs before the Worker's ESM bundle can fail to import a package.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_BYTES = 10 * 1024 * 1024;
const BACKUPS = 3;
const FLAGS = fs.constants;

function safeFile(file, allowMissing = false) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat && allowMissing) return null;
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) {
    throw new Error('unsafe log file');
  }
  return stat;
}

function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }

function copyRange(source, destination, start, length) {
  const fd = fs.openSync(destination, FLAGS.O_WRONLY | FLAGS.O_CREAT | FLAGS.O_EXCL | FLAGS.O_NOFOLLOW, 0o600);
  try {
    const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, length)));
    let position = start;
    while (position < start + length) {
      const count = fs.readSync(source, buffer, 0, Math.min(buffer.length, start + length - position), position);
      if (count === 0) throw new Error('log changed while copying');
      let written = 0;
      while (written < count) written += fs.writeSync(fd, buffer, written, count - written);
      position += count;
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

/** Copy/truncate preserves launchd's open stdout/stderr inode; only app-owned log names rotate. */
function createManagedLogWriter(root, name, descriptor, maxBytes = MAX_BYTES) {
  if (!['service.stdout.log', 'service.stderr.log'].includes(name)
    || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('invalid log policy');
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync(root) !== root
    || rootStat.uid !== process.getuid() || (rootStat.mode & 0o777) !== 0o700) {
    throw new Error('unsafe log directory');
  }
  const file = path.join(root, name);
  const identity = fs.fstatSync(descriptor);
  if (!sameFile(identity, safeFile(file))) throw new Error('unmanaged output descriptor');
  const readFd = fs.openSync(file, FLAGS.O_RDONLY | FLAGS.O_NOFOLLOW);
  if (!sameFile(identity, fs.fstatSync(readFd))) { fs.closeSync(readFd); throw new Error('log identity changed'); }
  const marker = `${file}.bounded-v1`;
  const legacy = `${file}.legacy`;
  const temporary = `${file}.rotate-${crypto.randomUUID()}`;
  const recheck = () => {
    const currentRoot = fs.lstatSync(root);
    if (!sameFile(rootStat, currentRoot) || fs.realpathSync(root) !== root
      || !sameFile(identity, safeFile(file))) throw new Error('log identity changed');
  };
  try {
    recheck();
    if (!safeFile(marker, true)) {
      if (identity.size > 0) {
        if (safeFile(legacy, true)) throw new Error('legacy log already exists without marker');
        copyRange(readFd, temporary, 0, identity.size);
        fs.linkSync(temporary, legacy); // Never overwrite an existing historical copy.
        fs.unlinkSync(temporary);
      }
      const markerFd = fs.openSync(marker, FLAGS.O_WRONLY | FLAGS.O_CREAT | FLAGS.O_EXCL | FLAGS.O_NOFOLLOW, 0o600);
      try { fs.writeSync(markerFd, 'bounded-worker-log-v1\n'); fs.fsyncSync(markerFd); }
      finally { fs.closeSync(markerFd); }
      recheck();
      fs.ftruncateSync(descriptor, 0);
    }
  } catch (error) {
    try { if (safeFile(temporary, true)) fs.unlinkSync(temporary); } catch {}
    fs.closeSync(readFd);
    throw error;
  }

  function rotate(size) {
    recheck();
    for (let index = 1; index <= BACKUPS; index++) safeFile(`${file}.${index}`, true);
    try {
      // Prepare the complete bounded copy before removing any existing rolling backup.
      copyRange(readFd, temporary, Math.max(0, size - maxBytes), Math.min(size, maxBytes));
      if (safeFile(`${file}.${BACKUPS}`, true)) fs.unlinkSync(`${file}.${BACKUPS}`);
      for (let index = BACKUPS - 1; index >= 1; index--) {
        if (safeFile(`${file}.${index}`, true)) fs.renameSync(`${file}.${index}`, `${file}.${index + 1}`);
      }
      fs.renameSync(temporary, `${file}.1`);
      recheck();
      fs.ftruncateSync(descriptor, 0);
    } finally {
      // A failed copy or publication must not leave an exclusive temporary blocking retries.
      try { if (safeFile(temporary, true)) fs.unlinkSync(temporary); } catch {}
    }
  }

  return {
    write(buffer) {
      let offset = 0;
      while (offset < buffer.length) {
        recheck();
        let size = fs.fstatSync(descriptor).size;
        if (size >= maxBytes || (offset === 0 && buffer.length <= maxBytes && size + buffer.length > maxBytes)) {
          rotate(size); size = 0;
        }
        const length = Math.min(buffer.length - offset, maxBytes - size, 64 * 1024);
        const count = fs.writeSync(descriptor, buffer, offset, length, size);
        if (count === 0) throw new Error('log write made no progress');
        offset += count;
      }
    },
    close() { fs.closeSync(readFd); },
  };
}

function installManagedWorkerLogs(configFile) {
  if (!configFile || path.basename(configFile) !== 'worker.json') return;
  const root = path.dirname(configFile);
  if (!/^worker-[a-f0-9]{24}$/.test(path.basename(root))) return;
  safeFile(configFile);
  let installed = false;
  for (const [stream, name] of [[process.stdout, 'service.stdout.log'], [process.stderr, 'service.stderr.log']]) {
    const output = fs.fstatSync(stream.fd);
    const expected = fs.lstatSync(path.join(root, name), { throwIfNoEntry: false });
    // Interactive output and unrelated redirections are not managed log files.
    if (!output.isFile() || !expected || !sameFile(output, expected)) continue;
    let warned = false;
    const warn = () => {
      if (warned) return;
      warned = true;
      try {
        process.stderr.write(`${JSON.stringify({
          timestamp: new Date().toISOString(), level: 'warn', event: 'worker-log-retention-unavailable',
          channel: stream === process.stdout ? 'stdout' : 'stderr',
        })}\n`);
      } catch { /* Preserve the runtime when even the diagnostic sink has failed. */ }
    };
    let writer;
    try { writer = createManagedLogWriter(root, name, stream.fd); }
    catch { warn(); continue; }
    const original = stream.write.bind(stream);
    installed = true;
    stream.on('error', () => undefined);
    stream.write = (chunk, encoding, callback) => {
      const complete = typeof encoding === 'function' ? encoding : callback;
      try {
        const data = Buffer.isBuffer(chunk) ? chunk
          : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined);
        writer.write(data);
        if (complete) queueMicrotask(() => complete());
        return true;
      } catch {
        // A diagnostic I/O failure must not stop the Worker or damage its original logs.
        warn();
        return original(chunk, encoding, callback);
      }
    };
  }
  return installed ? root : null;
}

/** Persist only a fixed failure code and counters so launchd restart loops do not spam stderr. */
function startupFailureRecord(root, code, now = Date.now()) {
  const stateFile = path.join(root, '.startup-failure.json');
  const previousStat = safeFile(stateFile, true);
  let previous = null;
  if (previousStat && previousStat.size <= 4096) {
    try { previous = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  }
  const same = previous?.code === code && Number.isSafeInteger(previous.at)
    && previous.at <= now && Number.isSafeInteger(previous.count) && previous.count >= 0;
  const suppressed = same ? Math.min(9999, previous.count + 1) : 0;
  const emit = !same || now - previous.at >= 60_000;
  const next = { code, at: emit ? now : previous.at, count: emit ? 0 : suppressed };
  const temporary = `${stateFile}.${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
    safeFile(stateFile, true);
    fs.renameSync(temporary, stateFile);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return emit ? {
    timestamp: new Date(now).toISOString(), level: 'error', event: 'worker-startup-failed', code,
    ...(same ? { suppressedCount: previous.count } : {}),
  } : null;
}

module.exports = { createManagedLogWriter, installManagedWorkerLogs, startupFailureRecord, MAX_BYTES, BACKUPS };
