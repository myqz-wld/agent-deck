import { createRequire } from 'node:module';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { createManagedLogWriter, startupFailureRecord, MAX_BYTES, BACKUPS } = require('../resources/bin/worker-log-retention.cjs');
const bootstrap = fileURLToPath(new URL('../resources/bin/worker-log-bootstrap.cjs', import.meta.url));
const cleanup = [];

afterEach(() => { for (const action of cleanup.splice(0).reverse()) action(); });

function fixture(content = '') {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'worker-log-test-')));
  cleanup.push(() => rmSync(base, { force: true, recursive: true }));
  const root = join(base, `worker-${'1'.repeat(24)}`);
  mkdirSync(root, { mode: 0o700 });
  const file = join(root, 'service.stderr.log');
  writeFileSync(file, content, { mode: 0o600 });
  const fd = openSync(file, 'a');
  cleanup.push(() => closeSync(fd));
  const writer = (limit = 32) => {
    const result = createManagedLogWriter(root, 'service.stderr.log', fd, limit);
    cleanup.push(() => result.close());
    return result;
  };
  return { base, root, file, fd, writer };
}

describe('managed Worker log retention', () => {
  it('preserves legacy history and the active inode while bounding all rolling files', () => {
    const f = fixture('historical evidence\n');
    const inode = statSync(f.file).ino;
    const log = f.writer();
    log.write(Buffer.from('a'.repeat(32 * 7 + 5)));
    expect(statSync(f.file).ino).toBe(inode);
    expect(readFileSync(`${f.file}.legacy`, 'utf8')).toBe('historical evidence\n');
    expect(statSync(f.file).size).toBe(5);
    for (let index = 1; index <= BACKUPS; index++) {
      expect(statSync(`${f.file}.${index}`).size).toBe(32);
      expect(statSync(`${f.file}.${index}`).mode & 0o777).toBe(0o600);
    }
    expect(existsSync(`${f.file}.4`)).toBe(false);
    expect(readdirSync(f.root).some((name) => name.includes('.rotate-'))).toBe(false);
    expect(MAX_BYTES).toBe(10 * 1024 * 1024);
    // A later process sees the marker and never archives/clears the current log again.
    f.writer().write(Buffer.from('b'));
    expect(readFileSync(f.file, 'utf8')).toBe('aaaaab');
    expect(readFileSync(`${f.file}.legacy`, 'utf8')).toBe('historical evidence\n');
  });

  it('refuses a symlinked backup without touching the target or active data', () => {
    const f = fixture();
    const target = join(f.base, 'unrelated');
    writeFileSync(target, 'preserve me', { mode: 0o600 });
    const log = f.writer();
    log.write(Buffer.from('a'.repeat(32)));
    symlinkSync(target, `${f.file}.1`);
    expect(() => log.write(Buffer.from('b'))).toThrow('unsafe log file');
    expect(readFileSync(target, 'utf8')).toBe('preserve me');
    expect(readFileSync(f.file, 'utf8')).toBe('a'.repeat(32));
  });

  it('does not truncate the sole history copy when legacy publication cannot proceed', () => {
    const f = fixture('preserve current history');
    writeFileSync(`${f.file}.legacy`, 'older independent history', { mode: 0o600 });
    expect(() => f.writer()).toThrow('legacy log already exists');
    expect(readFileSync(f.file, 'utf8')).toBe('preserve current history');
    expect(readFileSync(`${f.file}.legacy`, 'utf8')).toBe('older independent history');
  });

  it('can retry rotation after a failed backup publication without losing the active log', () => {
    const f = fixture();
    const log = f.writer();
    log.write(Buffer.from('a'.repeat(32)));
    const rename = vi.spyOn(require('node:fs'), 'renameSync').mockImplementationOnce(() => {
      throw new Error('simulated disk failure');
    });
    try {
      expect(() => log.write(Buffer.from('b'))).toThrow('simulated disk failure');
    } finally { rename.mockRestore(); }
    expect(readFileSync(f.file, 'utf8')).toBe('a'.repeat(32));
    expect(readdirSync(f.root).some((name) => name.includes('.rotate-'))).toBe(false);
    log.write(Buffer.from('b'));
    expect(readFileSync(f.file, 'utf8')).toBe('b');
    expect(readFileSync(`${f.file}.1`, 'utf8')).toBe('a'.repeat(32));
  });

  it('rejects a different open descriptor before archiving anything', () => {
    const f = fixture('preserve history');
    const other = join(f.root, 'other.log');
    writeFileSync(other, '', { mode: 0o600 });
    const fd = openSync(other, 'a');
    try {
      expect(() => createManagedLogWriter(f.root, 'service.stderr.log', fd)).toThrow('unmanaged');
    } finally { closeSync(fd); }
    expect(readFileSync(f.file, 'utf8')).toBe('preserve history');
    expect(existsSync(`${f.file}.legacy`)).toBe(false);
  });

  it('catches an ESM import failure before the runtime loads and emits only a structured category', () => {
    const f = fixture('old startup evidence\n');
    const config = join(f.root, 'worker.json');
    writeFileSync(config, '{}', { mode: 0o600 });
    const stdout = join(f.root, 'service.stdout.log');
    writeFileSync(stdout, '', { mode: 0o600 });
    const outputFd = openSync(stdout, 'a');
    const entry = join(f.base, 'broken-entry.mjs');
    writeFileSync(entry, "import 'private-missing-package';\n");
    try {
      for (let i = 0; i < 3; i++) {
        const result = spawnSync(process.execPath, [bootstrap, entry, 'serve', '--config', config], {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          stdio: ['ignore', outputFd, f.fd], timeout: 10_000,
        });
        expect(result.status).toBe(1);
      }
    } finally { closeSync(outputFd); }
    const text = readFileSync(f.file, 'utf8');
    const records = text.trim().split('\n').map(JSON.parse);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ event: 'worker-startup-failed', code: 'ERR_MODULE_NOT_FOUND' });
    expect(records[0].timestamp).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(text).not.toMatch(/private-missing-package|at |Error \[|broken-entry/);
    expect(readFileSync(`${f.file}.legacy`, 'utf8')).toBe('old startup evidence\n');
    expect(JSON.parse(readFileSync(join(f.root, '.startup-failure.json'), 'utf8')).count).toBe(2);
  });

  it('keeps a normal structured record whole across rotation and aggregates repeated startup failures', () => {
    const f = fixture();
    const log = f.writer(64);
    const record = `${JSON.stringify({ event: 'first', count: 1 })}\n`;
    log.write(Buffer.from('x'.repeat(50)));
    log.write(Buffer.from(record));
    expect(readFileSync(f.file, 'utf8')).toBe(record);
    expect(readFileSync(`${f.file}.1`, 'utf8')).toBe('x'.repeat(50));
    expect(startupFailureRecord(f.root, 'ERR_MODULE_NOT_FOUND', 0)).toMatchObject({ code: 'ERR_MODULE_NOT_FOUND' });
    expect(startupFailureRecord(f.root, 'ERR_MODULE_NOT_FOUND', 10)).toBeNull();
    expect(startupFailureRecord(f.root, 'ERR_MODULE_NOT_FOUND', 60_000)).toMatchObject({ suppressedCount: 1 });
  });

  it('preserves the runtime exit code and uses the bootstrap only for managed macOS serve', () => {
    const f = fixture();
    const config = join(f.root, 'worker.json');
    writeFileSync(config, '{}', { mode: 0o600 });
    const entry = join(f.base, 'entry.mjs');
    writeFileSync(entry, 'export async function runLocalWorkerEntrypoint(argv) { return argv[0] === "serve" ? 7 : 9; }');
    const result = spawnSync(process.execPath, [bootstrap, entry, 'serve', '--config', config], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10_000,
    });
    expect(result.status).toBe(7);
    const wrapper = readFileSync(resolve(dirname(bootstrap), 'agent-deck-worker'), 'utf8');
    expect(wrapper).toContain('"$platform" == Darwin && "${1:-}" == serve');
    expect(wrapper).toContain('worker-log-bootstrap.cjs');
  });

  it('reports unavailable retention without preventing runtime startup or overwriting old history', () => {
    const f = fixture('preserve current history\n');
    writeFileSync(`${f.file}.legacy`, 'independent history', { mode: 0o600 });
    const config = join(f.root, 'worker.json');
    writeFileSync(config, '{}', { mode: 0o600 });
    const entry = join(f.base, 'entry.mjs');
    writeFileSync(entry, 'export async function runLocalWorkerEntrypoint() { return 7; }');
    const result = spawnSync(process.execPath, [bootstrap, entry, 'serve', '--config', config], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', f.fd], timeout: 10_000,
    });
    expect(result.status).toBe(7);
    const text = readFileSync(f.file, 'utf8');
    expect(text).toMatch(/^preserve current history\n/);
    expect(JSON.parse(text.trim().split('\n')[1])).toMatchObject({
      event: 'worker-log-retention-unavailable', level: 'warn', channel: 'stderr',
    });
    expect(readFileSync(`${f.file}.legacy`, 'utf8')).toBe('independent history');
  });
});
