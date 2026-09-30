import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRODUCTION_FEISHU_PATHS } from './feishu-provisioning';
import { activateDesiredFeishuRuntime, inspectFeishuRuntimeRelease } from './feishu-runtime-release';
import { pruneFeishuRuntimeReleases } from './feishu-runtime-retention';
import { upgradeFeishuRuntime } from './feishu-runtime-upgrade';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const D = 'd'.repeat(64);

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'feishu-retention-')));
  roots.push(root);
  const paths = {
    ...PRODUCTION_FEISHU_PATHS,
    runtimeRoot: root,
    stateDirectory: join(root, 'state'),
    runtimeReleases: join(root, 'releases'),
    runtimeActive: join(root, 'active'),
    runtimeDesired: join(root, 'desired'),
  };
  chmodSync(root, 0o755);
  mkdirSync(paths.runtimeReleases, { mode: 0o755 });
  const release = (digest: string): string => {
    const path = join(paths.runtimeReleases, digest);
    mkdirSync(join(path, 'bin'), { recursive: true, mode: 0o755 });
    mkdirSync(join(path, 'app'), { mode: 0o755 });
    const files = { 'bin/node': 'runtime', 'app/index.mjs': digest, 'runtime.json': '{}' };
    for (const [name, text] of Object.entries(files)) writeFileSync(join(path, name), text, { mode: 0o644 });
    const sums = Object.entries(files).map(([name, text]) =>
      `${createHash('sha256').update(text).digest('hex')}  ./${name}\n`).join('');
    writeFileSync(join(path, 'SHA256SUMS'), sums, { mode: 0o644 });
    return path;
  };
  const pointers = (active: string, desired: string): void => {
    writeFileSync(paths.runtimeActive, `${active}\n`, { mode: 0o644 });
    writeFileSync(paths.runtimeDesired, `${desired}\n`, { mode: 0o644 });
  };
  const activate = () => activateDesiredFeishuRuntime(inspectFeishuRuntimeRelease(paths));
  return { paths, release, pointers, activate };
}

describe('post-acceptance Feishu runtime retention', () => {
  it('bounds successive upgrades to active and verified rollback and survives a same-release restart', async () => {
    const t = fixture();
    const a = t.release(A); const b = t.release(B); const c = t.release(C);
    t.pointers(B, C);
    const applied = t.activate();
    expect(await pruneFeishuRuntimeReleases(t.paths, applied, () => new Set())).toMatchObject({
      status: 'completed', removed: [A], retained: [B, C],
    });
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b) && existsSync(c)).toBe(true);
    const history = readFileSync(join(t.paths.runtimeRoot, 'retention.json'), 'utf8');
    expect(JSON.parse(history)).toMatchObject({ activeDigest: C, rollbackDigest: B });
    expect(await pruneFeishuRuntimeReleases(t.paths, t.activate(), () => new Set())).toMatchObject({
      status: 'completed', removed: [], retained: [B, C],
    });
    t.release(D); t.pointers(C, D);
    expect(await pruneFeishuRuntimeReleases(t.paths, t.activate(), () => new Set())).toMatchObject({
      status: 'completed', removed: [B], retained: [C, D],
    });
  });

  it('never infers a missing rollback record from directory times', async () => {
    const t = fixture();
    t.release(A); t.release(B); t.pointers(B, B);
    expect(await pruneFeishuRuntimeReleases(t.paths, t.activate(), () => new Set())).toMatchObject({
      status: 'skipped', removed: [],
    });
    expect(existsSync(join(t.paths.runtimeReleases, A))).toBe(true);
  });

  it('preserves live, changed, linked, unknown and credential data while pruning a safe release', async () => {
    const t = fixture();
    const old = t.release(A); const active = t.release(B); t.release(C); const live = t.release(D);
    const changed = t.release('e'.repeat(64));
    writeFileSync(join(changed, 'app/index.mjs'), 'modified');
    const linked = join(t.paths.runtimeReleases, 'f'.repeat(64));
    symlinkSync(active, linked);
    const extra = join(t.paths.runtimeRoot, 'credentials');
    writeFileSync(extra, 'preserve private state', { mode: 0o600 });
    mkdirSync(join(t.paths.runtimeReleases, 'unmanaged'));
    t.pointers(B, C);
    expect(await pruneFeishuRuntimeReleases(t.paths, t.activate(), () => new Set([D]))).toMatchObject({
      status: 'partial', removed: [A],
    });
    expect(existsSync(old)).toBe(false);
    for (const path of [active, live, changed, linked, extra, join(t.paths.runtimeReleases, 'unmanaged')]) {
      expect(existsSync(path)).toBe(true);
    }
  });

  it('fails closed on unreadable process references and changed desired pointers', async () => {
    const t = fixture();
    t.release(A); t.release(B); t.release(C); t.release(D); t.pointers(B, C);
    const applied = t.activate();
    expect(await pruneFeishuRuntimeReleases(t.paths, applied, () => { throw new Error('access'); }))
      .toMatchObject({ status: 'skipped', removed: [] });
    t.pointers(C, D);
    expect(await pruneFeishuRuntimeReleases(t.paths, applied, () => new Set()))
      .toMatchObject({ status: 'skipped', removed: [] });
    expect(existsSync(join(t.paths.runtimeReleases, A))).toBe(true);
  });

  it('retains a release that becomes referenced while its checksum is being inspected', async () => {
    const t = fixture();
    t.release(A); t.release(B); t.release(C); t.pointers(B, C);
    const references = vi.fn().mockReturnValueOnce(new Set()).mockReturnValue(new Set([A]));
    expect(await pruneFeishuRuntimeReleases(t.paths, t.activate(), references)).toMatchObject({
      status: 'completed', removed: [], retained: [A, B, C],
    });
  });

  it('never prunes a failed activation or rolls back a healthy activation on cleanup failure', async () => {
    const t = fixture();
    t.release(A); t.release(B); t.pointers(A, B);
    mkdirSync(t.paths.stateDirectory, { mode: 0o700 });
    const owner = { uid: process.getuid!(), gid: process.getgid!() };
    const systemd = {
      daemonReload: vi.fn(), restart: vi.fn(), isActive: vi.fn(),
      enableNow: vi.fn(), stopDisable: vi.fn(), stop: vi.fn(),
    };
    const retention = { prune: vi.fn().mockRejectedValue(new Error('cleanup failed')) };
    const health = vi.fn().mockRejectedValueOnce(new Error('unhealthy')).mockResolvedValue({ healthy: true });
    await expect(upgradeFeishuRuntime(t.paths, systemd, health, retention, owner)).rejects.toThrow('unhealthy');
    expect(retention.prune).not.toHaveBeenCalled();
    expect(readFileSync(t.paths.runtimeActive, 'utf8')).toBe(`${A}\n`);
    systemd.restart.mockClear();
    await expect(upgradeFeishuRuntime(t.paths, systemd, health, retention, owner)).resolves.toMatchObject({
      status: 'upgraded', cleanup: { status: 'skipped' },
    });
    expect(systemd.restart).toHaveBeenCalledTimes(1);
    expect(readFileSync(t.paths.runtimeActive, 'utf8')).toBe(`${B}\n`);
  });
});
