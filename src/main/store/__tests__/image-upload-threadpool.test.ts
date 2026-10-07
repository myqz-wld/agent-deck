import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

// This proves a native failure mechanism, not that the exited user's process had this cause.
// Blocking belongs only to a disposable child; no application process or user file is touched.
it.skipIf(process.platform === 'win32')('reproduces shared filesystem starvation with responsive timers and sync I/O', () => {
  const probe = String.raw`
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-io-probe-'));
    const pipe = path.join(root, 'blocked-open');
    const config = path.join(root, 'config.toml');
    fs.writeFileSync(config, 'model="synthetic"');
    const fifo = spawnSync('/usr/bin/mkfifo', [pipe]);
    if (fifo.status !== 0) throw new Error('Cannot create synthetic FIFO');
    const blocked = fs.promises.open(pipe, 'r');
    let mkdirDone = false;
    let openDone = false;
    let callbackDone = false;
    const mkdir = fs.promises.mkdir(path.join(root, 'images')).then(() => { mkdirDone = true; });
    const open = fs.promises.open(config, 'r').then(async (handle) => { openDone = true; await handle.close(); });
    const callback = new Promise((resolve) => fs.stat(config, () => { callbackDone = true; resolve(); }));
    setTimeout(async () => {
      const observed = {
        mkdirPending: !mkdirDone, openPending: !openDone, callbackPending: !callbackDone,
        syncReadHealthy: fs.readFileSync(config, 'utf8') === 'model="synthetic"',
        activeFsRequests: process.getActiveResourcesInfo().filter((type) => type.startsWith('FSReq')).length,
      };
      const writer = fs.openSync(pipe, 'w');
      fs.closeSync(writer);
      await (await blocked).close();
      await Promise.all([mkdir, open, callback]);
      fs.rmSync(root, { recursive: true, force: true });
      process.stdout.write(JSON.stringify({ ...observed, recovered: mkdirDone && openDone && callbackDone }));
    }, 100);
  `;
  const child = spawnSync(process.execPath, ['-e', probe], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', UV_THREADPOOL_SIZE: '1' },
    encoding: 'utf8', timeout: 5_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toMatchObject({
    mkdirPending: true, openPending: true, callbackPending: true,
    syncReadHealthy: true, recovered: true,
  });
  expect(JSON.parse(child.stdout).activeFsRequests).toBeGreaterThanOrEqual(4);
});
