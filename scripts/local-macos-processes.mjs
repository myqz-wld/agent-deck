import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';

export function parseProcessTable(output) {
  return output.split('\n').filter((line) => line.trim()).map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    if (!match) throw new Error('无法解析进程身份，已取消安装。');
    return {
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      startedAt: match[3].replace(/\s+/g, ' '),
      executable: match[4],
    };
  });
}

export function installedAppProcesses(appPath, rows) {
  const prefix = `${resolve(appPath)}/Contents/`;
  return rows.filter((row) => row.executable.startsWith(prefix));
}

function readProcesses() {
  return parseProcessTable(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,comm='], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  }));
}

export function assertInstalledAppStopped(appPath, read = readProcesses) {
  if (installedAppProcesses(appPath, read()).length > 0) {
    throw new Error('Agent Deck 仍在运行。请先退出应用；明确允许退出该安装实例时，可使用 --stop-running。');
  }
}

function sameIdentity(first, second) {
  return first.pid === second.pid && first.startedAt === second.startedAt &&
    first.executable === second.executable;
}

export async function stopInstalledApp(appPath, options = {}) {
  const {
    read = readProcesses,
    signal = (pid) => process.kill(pid, 'SIGTERM'),
    quit = () => execFileSync('/usr/bin/osascript', [
      '-e', `tell application ${JSON.stringify(resolve(appPath))} to quit`,
    ], { timeout: 20_000, stdio: 'ignore' }),
    sleep = setTimeout,
    now = Date.now,
    graceMs = 25_000,
    terminateMs = 10_000,
  } = options;
  const snapshot = installedAppProcesses(appPath, read());
  if (snapshot.length === 0) return;
  const mainPath = resolve(appPath, 'Contents/MacOS/Agent Deck');
  if (snapshot.filter((row) => row.executable === mainPath).length > 1) {
    throw new Error('发现多个 Agent Deck 主进程，无法唯一确认安装目标，已取消安装。');
  }
  const remaining = () => {
    const current = installedAppProcesses(appPath, read());
    if (current.some((row) => !snapshot.some((old) => sameIdentity(old, row)))) {
      throw new Error('Agent Deck 进程身份已变化，已取消退出和安装。请重新核实目标。');
    }
    return current;
  };
  if (remaining().some((row) => row.executable === mainPath)) {
    // A failed/timed-out Apple Event may still have initiated graceful shutdown.
    try { quit(); } catch { /* Wait, then revalidate before the bounded SIGTERM fallback. */ }
  }
  const waitForExit = async (duration) => {
    const deadline = now() + duration;
    while (remaining().length > 0) {
      if (now() >= deadline) return false;
      await sleep(Math.min(250, deadline - now()));
    }
    return true;
  };
  if (await waitForExit(graceMs)) return;
  for (const old of snapshot) {
    // Re-read immediately before each signal; never signal a reused PID or another app copy.
    if (!remaining().some((row) => sameIdentity(old, row))) continue;
    try { signal(old.pid); } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  if (!await waitForExit(terminateMs)) {
    throw new Error('已核实的 Agent Deck 进程未在期限内退出，已取消安装；请手动退出后重试。');
  }
}
